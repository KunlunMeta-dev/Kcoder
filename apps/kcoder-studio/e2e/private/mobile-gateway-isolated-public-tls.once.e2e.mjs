import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connect as connectTls } from "node:tls";
import { createMobileLatencyHelpers } from "../harness/mobile-latency-helpers.mjs";
import { inspectMatchedMobileWebExport, materializeMatchedMobileStaticDist } from "../harness/matched-mobile-static-dist.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { materializeWorkspace } from "../harness/workspace-fixture.mjs";
import { RunContext, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { buildMarkedPythonSource, createOwnedSshDispatcher, remoteOwnedProcessGuardSource, runOwnedSshOperation, startOwnedSshControlMaster }
  from "../harness/owned-ssh-control-master.mjs";
import { verifyOfficialMobileSourceSnapshot } from "../harness/official-mobile-export-receipt.mjs";
import { currentProcessFence, inspectProcessFence, readOptionalPrivateRunJson, readPrivateRunJson,
  validateProductionRecoveryPlan, writeDurableRecoveryIntent, writeFixtureJson, writePrivateRecoveryAck,
  productionAtomicFsCoreSource, productionCandidateStageSource }
  from "./mobile-gateway-production-caddy-recovery.mjs";

// Private once-run; Root review precedes remote startup. Local contract: --local-caddy-rollback-preflight.
const RUN_FLAG = "KCODER_E2E_ISOLATED_PUBLIC_TLS_MOBILE_ONCE";
const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const SSH_BIN = "/usr/bin/ssh";
const REMOTE_NODE18 = "/usr/bin/node";
const RELAY_COMMIT = "25a137ab";
const MAIN_REPO_ROOT = resolve(repoRoot, "..", "..");
const RELAY_SERVER_BASE_SHA256 = "00b67c45f48fd3759c744bc8ab38d0980b3c31765c279d71b0f81557991ce499";
const RELAY_SERVER_BASE_BYTES = 54_992;
const RELAY_SERVER_PATCHED_SHA256 = "08ecbad2fd8139bceac92fc1ae17b0dd8f54811ee844341eef965a663a0e0f5b";
const RELAY_PATCH_SHA256 = "171bc924d00d828694715e3a50be5ff304b4ee0a729bb64c228735dea962fbad";
const RELAY_SOURCE_PINS = Object.freeze({
  "apps/kcoder-relay/src/server.mjs": RELAY_SERVER_BASE_SHA256,
  "apps/kcoder-relay/src/transport.mjs": "8b94ae9f08cf088e4afdc59bba6594554cc3cd488f151a2229b9340eac8bf012",
  "apps/kcoder-relay/src/server-routing.mjs": "b0f4c2519d75c464227d4b2d7bbc5b9d8cdc19e26690daf0fb1644d13893c4bb",
  "apps/kcoder-relay/src/config.mjs": "b24e5c93198e0b5e0d9478785d5be8ecb826bb69479ac3a4a04a09acdd762335",
  "apps/kcoder-relay/src/registration-store.mjs": "ea310dd7a31a4e1d4f8a62ecedff84dba219cefa08ab64b89fd38c4fb186cf78",
  "apps/kcoder-relay/src/client.mjs": "339d7d85a203d2a6293138c000d0a17aa6bb0de1ae40bb9e524aae0073d988f8",
  "apps/kcoder-relay/src/client-identity.mjs": "c9e22731e4b553b1060f5dc4060de5ff4f37483527ade1a28104741c2500aa7d",
});

function shaBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function shaFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function loadPinnedRelayInputs() {
  const files = new Map();
  for (const [path, expectedSha256] of Object.entries(RELAY_SOURCE_PINS)) {
    const bytes = execFileSync("git", ["show", RELAY_COMMIT + ":" + path], { cwd: repoRoot, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(shaBytes(bytes), expectedSha256, "pinned historical Relay source changed: " + path);
    files.set(path, bytes);
  }
  const baseline = files.get("apps/kcoder-relay/src/server.mjs").toString("utf8");
  assert.equal(Buffer.byteLength(baseline), RELAY_SERVER_BASE_BYTES);
  const patchedServer = patchMountProofServer(baseline);
  const patchedServerSha256 = shaBytes(Buffer.from(patchedServer));
  assert.equal(patchedServerSha256, RELAY_SERVER_PATCHED_SHA256);
  const patchBytes = await readFile(RELAY_PATCH_ARTIFACT);
  assert.equal(shaBytes(patchBytes), RELAY_PATCH_SHA256);
  const relayRoot = resolve(MAIN_REPO_ROOT, "apps/kcoder-relay");
  const clientPath = resolve(relayRoot, "src/client.mjs");
  const wsRoot = await realpath(resolve(relayRoot, "node_modules/ws"));
  assert.equal(await realpath(resolve(relayRoot, "node_modules/ws")), wsRoot);
  const wsEntry = await realpath(createRequire(clientPath).resolve("ws"));
  assert.equal(dirname(wsEntry), wsRoot);
  const wsPackage = JSON.parse(await readFile(resolve(wsRoot, "package.json"), "utf8"));
  assert.equal(wsPackage.version, WS_PIN.version);
  const wsRows = [];
  await walkPinnedTree(wsRoot, wsRoot, wsRows);
  const wsPackageTreeSha256 = shaBytes(Buffer.from(wsRows.sort(([a], [b]) => a.localeCompare(b))
    .map(([path, digest]) => path + "\0" + digest + "\n").join("")));
  assert.equal(wsPackageTreeSha256, WS_PIN.packageTreeSha256);
  const sourceRows = [...files].map(([path, bytes]) => [path, shaBytes(bytes)]).sort(([a], [b]) => a.localeCompare(b));
  const sourceClosureSha256 = shaBytes(Buffer.from(sourceRows.map(([path, digest]) => path + "\0" + digest + "\n").join("")));
  return { files, patchedServer, patchedServerSha256, patchSha256: shaBytes(patchBytes), sourceClosureSha256,
    wsRoot, wsVersion: wsPackage.version, wsPackageTreeSha256 };
}

async function verifyMatchedMobileSourceSnapshot() {
  const { root, manifestSha256, sourceCommit } = MATCHED_MOBILE_SOURCE_SNAPSHOT;
  assert.equal(await shaFile(join(root, "sha256.json")), manifestSha256);
  const verified = await verifyOfficialMobileSourceSnapshot(root, sourceCommit, { repoRoot });
  return {
    ...verified,
    sourceSnapshotPath: relative(repoRoot, root),
    sourceSnapshotManifestSha256: manifestSha256,
  };
}

function patchMountProofServer(source) {
  const originalImport = "import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';";
  const patchedImport = "import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';";
  const originalBlock = [
    "    const headers = hopHeaders(request.headers);", "    headers.host = request.headers.host;",
    "    headers.connection = 'close';", "    if (bufferedBody) {",
  ].join("\n");
  const patchedBlock = [
    "    const headers = hopHeaders(request.headers);", "    headers.host = request.headers.host;",
    "    headers.connection = 'close';",
    "    // Presentation proof only; never forwarded as an API/RPC credential.",
    "    // Pairing users know this key. It attests a mount at pairing authority,",
    "    // not possession of the Relay's private registration/control secret.",
    "    delete headers['x-kcoder-mobile-mount'];", "    delete headers['x-kcoder-mobile-mount-proof'];",
    "    if (route.shared && gateway.pairingToken &&",
    "        (path === '/mobile-entry' || path === '/mobile' || path.startsWith('/mobile/'))) {",
    "      const prefix = \x60/g/\x24{gateway.id}\x60;",
    "      const canonicalHost = new URL(\x60http://\x24{authority}\x60).host;",
    "      headers['x-kcoder-mobile-mount'] = prefix;",
    "      headers['x-kcoder-mobile-mount-proof'] = createHmac('sha256', gateway.pairingToken)",
    "        .update(JSON.stringify(['kcoder-mobile-mount-v1', canonicalHost, prefix])).digest('hex');",
    "    }", "    if (bufferedBody) {",
  ].join("\n");
  assert.equal(source.split(originalImport).length - 1, 1);
  assert.equal(source.split(originalBlock).length - 1, 1);
  assert.equal(source.includes("x-kcoder-mobile-mount"), false);
  return source.replace(originalImport, patchedImport).replace(originalBlock, patchedBlock);
}

async function walkPinnedTree(root, directory, rows) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, "pinned ws dependency contains no symbolic links");
    if (entry.isDirectory()) await walkPinnedTree(root, path, rows);
    else {
      assert.ok(info.isFile());
      rows.push([relative(root, path).split("\\").join("/"), shaBytes(await readFile(path))]);
    }
  }
}

async function materializePinnedRelayRuntime(context, runtimeRoot, files, patchedServer) {
  for (const [path, bytes] of files) {
    const destination = resolve(runtimeRoot, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, path === "apps/kcoder-relay/src/server.mjs" ? patchedServer : bytes,
      { flag: "wx", mode: 0o600 });
    await chmod(destination, 0o600);
  }
  const nodeModules = resolve(runtimeRoot, "apps/kcoder-relay/node_modules");
  await mkdir(nodeModules, { recursive: true, mode: 0o700 });
  await symlink(await realpath(resolve(MAIN_REPO_ROOT, "apps/kcoder-relay/node_modules/ws")), resolve(nodeModules, "ws"), "dir");
  const runtimeServer = resolve(runtimeRoot, "apps/kcoder-relay/src/server.mjs");
  assert.equal(await shaFile(runtimeServer), RELAY_SERVER_PATCHED_SHA256);
  for (const path of files.keys()) {
    const candidate = path === "apps/kcoder-relay/src/server.mjs" ? runtimeServer : resolve(runtimeRoot, path);
    const check = spawnSync(process.execPath, ["--check", candidate], { encoding: "utf8", timeout: 15_000 });
    assert.equal(check.status, 0, "pinned Relay module syntax check failed: " + path);
    assert.equal(check.error, undefined);
  }
  context.registerTemporaryDirectory("source-pinned isolated Relay runtime", runtimeRoot);
}

async function copyPinnedRustBinary(context) {
  const beforeInfo = await lstat(RUST_BINARY);
  assert.equal(beforeInfo.isFile(), true);
  assert.equal(beforeInfo.isSymbolicLink(), false);
  assert.equal(await realpath(RUST_BINARY), RUST_BINARY);
  const before = { dev: beforeInfo.dev, ino: beforeInfo.ino, bytes: beforeInfo.size, sha256: await shaFile(RUST_BINARY) };
  assert.deepEqual({ bytes: before.bytes, sha256: before.sha256 }, RUST_BINARY_PIN);
  const destination = context.pathInState("rust", "kcoder");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const sourceHandle = await open(RUST_BINARY, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let destinationHandle;
  try {
    destinationHandle = await open(destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o700);
    const openedSource = await sourceHandle.stat();
    assert.equal(openedSource.isFile(), true);
    assert.equal(openedSource.dev, before.dev);
    assert.equal(openedSource.ino, before.ino);
    const input = sourceHandle.createReadStream({ autoClose: false });
    const digest = createHash("sha256");
    let copiedBytes = 0;
    for await (const chunk of input) {
      digest.update(chunk);
      copiedBytes += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await destinationHandle.write(chunk, offset, chunk.length - offset, null);
        assert.ok(bytesWritten > 0);
        offset += bytesWritten;
      }
    }
    await destinationHandle.sync();
    await destinationHandle.chmod(0o700);
    const openedAfter = await sourceHandle.stat();
    assert.equal(openedAfter.dev, before.dev);
    assert.equal(openedAfter.ino, before.ino);
    assert.equal(openedAfter.size, before.bytes);
    assert.equal(copiedBytes, RUST_BINARY_PIN.bytes);
    assert.equal(digest.digest("hex"), RUST_BINARY_PIN.sha256);
  } finally {
    if (destinationHandle) await destinationHandle.close();
    await sourceHandle.close();
  }
  const copied = await regularFilePin(destination);
  const afterInfo = await lstat(RUST_BINARY);
  const after = { dev: afterInfo.dev, ino: afterInfo.ino, bytes: afterInfo.size, sha256: await shaFile(RUST_BINARY) };
  assert.deepEqual(copied, RUST_BINARY_PIN);
  assert.deepEqual(after, before, "source Rust binary changed during the owned copy");
  return { path: destination, sha256: copied.sha256, bytes: copied.bytes };
}

async function regularFilePin(path) {
  const info = await lstat(path);
  assert.equal(info.isFile(), true);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(await realpath(path), path);
  return { bytes: info.size, sha256: await shaFile(path) };
}

function requireAbsolute(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.startsWith("/"), name + " must be an absolute path");
  return value;
}

async function assertRegularNoSymlink(path) {
  const info = await lstat(path);
  assert.equal(info.isFile(), true);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(await realpath(path), path);
}

function validateMobileEntry(value, { mobileUrl, gatewayBase, pairingToken, relaySecret }) {
  const object = value !== null && typeof value === "object" && !Array.isArray(value);
  const keys = object && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["available", "gatewayUrl", "mobileUrl", "version"]);
  if (!keys || value.version !== 1 || value.available !== true) return { valid: false };
  try {
    const mobile = new URL(value.mobileUrl), gateway = new URL(value.gatewayUrl);
    const credentialFree = [mobile, gateway].every(url => url.protocol === "https:" && url.host === PUBLIC_HOST
      && !url.username && !url.password && !url.search && !url.hash)
      && !value.mobileUrl.includes(pairingToken) && !value.gatewayUrl.includes(pairingToken)
      && !value.mobileUrl.includes(relaySecret) && !value.gatewayUrl.includes(relaySecret);
    return { valid: credentialFree && value.mobileUrl === mobileUrl && value.gatewayUrl === gatewayBase };
  } catch { return { valid: false }; }
}

async function fetchEntry(url, timeoutMs) {
  const response = await fetch(url, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  assert.ok(Buffer.byteLength(body) <= 16 * 1024, "mobile-entry metadata response exceeded its bound");
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  return { status: response.status, body: parsed };
}

function createRegistrationFetchObserver({ expectedOrigin, fetchImpl = globalThis.fetch, onForward, onResponse }) {
  const origin = new URL(expectedOrigin);
  assert.equal(origin.origin, expectedOrigin);
  assert.equal(origin.pathname, "/");
  assert.equal(origin.search, "");
  assert.equal(origin.hash, "");
  assert.equal(typeof fetchImpl, "function");
  let forwardCount = 0;
  let responseStatus = null;
  const observedFetch = async (input, init) => {
    let inputUrl;
    let inheritedMethod = "GET";
    let requestInput = false;
    if (typeof input === "string") inputUrl = input;
    else if (input instanceof URL) inputUrl = input.href;
    else if (typeof Request === "function" && input instanceof Request) {
      inputUrl = input.url;
      inheritedMethod = input.method;
      requestInput = true;
    } else throw new TypeError("unsupported Relay registration fetch input");
    const url = new URL(inputUrl);
    const method = init?.method === undefined ? inheritedMethod : String(init.method);
    assert.equal(url.origin, expectedOrigin);
    assert.equal(url.pathname, "/_relay/register");
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(method.toUpperCase(), "POST");
    assert.equal(forwardCount, 0, "one local Relay registration request is allowed");
    forwardCount += 1;
    onForward?.(forwardCount);
    const response = init === undefined ? await fetchImpl(input) : await fetchImpl(input, init);
    responseStatus = response.status;
    onResponse?.(response.status, forwardCount);
    return response;
  };
  return Object.freeze({
    fetchImpl: observedFetch,
    get forwardCount() { return forwardCount; },
    get responseStatus() { return responseStatus; },
  });
}

async function verifyRegistrationFetchInputShapes() {
  const origin = "http://127.0.0.1:49321";
  const url = origin + "/_relay/register";
  const cases = [
    { input: url, init: { method: "POST" } },
    { input: new URL(url), init: { method: "POST" } },
    { input: new Request(url, { method: "POST" }), init: undefined },
  ];
  for (const sample of cases) {
    let forwarded = null;
    const fakeResponse = new Response("{}", { status: 201 });
    const observer = createRegistrationFetchObserver({ expectedOrigin: origin,
      fetchImpl: function(input, init) { forwarded = arguments; return Promise.resolve(fakeResponse); } });
    const response = sample.init === undefined
      ? await observer.fetchImpl(sample.input)
      : await observer.fetchImpl(sample.input, sample.init);
    assert.equal(response, fakeResponse);
    assert.equal(observer.forwardCount, 1);
    assert.equal(observer.responseStatus, 201);
    assert.equal(forwarded[0], sample.input, "observer forwards the exact input object");
    assert.equal(forwarded.length, sample.init === undefined ? 1 : 2, "observer preserves the fetch argument count");
    if (sample.init !== undefined) assert.equal(forwarded[1], sample.init, "observer forwards the exact init object");
  }
  return { inputKinds: 3, fetchArgumentsPreserved: true };
}

function assetKind(pathname, resourceType) {
  if (/\.html$/.test(pathname) || pathname.endsWith("/mobile/")) return "html";
  if (resourceType === "script" || /\.m?js$/.test(pathname)) return "javascript";
  if (resourceType === "stylesheet" || /\.css$/.test(pathname)) return "css";
  if (resourceType === "font" || /\.(?:woff2?|ttf|otf)$/.test(pathname)) return "font";
  return "other";
}

function classifyReverseForwardReadiness({ tunnelAlive, proxyForwardReachable, controlForwardReachable }) {
  if (!tunnelAlive) return "tunnel-exited";
  return proxyForwardReachable && controlForwardReachable ? "ready" : "pending";
}

async function captureAsset(response, kind) {
  const request = response.request();
  const [sizes, requestHeaders] = await Promise.all([request.sizes().catch(() => null), request.allHeaders().catch(() => ({}))]);
  const headers = response.headers(), timing = request.timing();
  const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
  const responseEnd = finite(timing.responseEnd), requestStart = finite(timing.requestStart);
  return { kind, status: response.status(), contentType: headers["content-type"]?.split(";", 1)[0] ?? "unknown",
    contentEncoding: headers["content-encoding"] ?? "identity", responseBodyBytes: finite(sizes?.responseBodySize),
    responseHeaderBytes: finite(sizes?.responseHeadersSize), contentLengthBytes: finite(Number(headers["content-length"])),
    timing: { requestToResponseMs: requestStart === null || responseEnd === null ? null : Number((responseEnd - requestStart).toFixed(2)), totalMs: responseEnd },
    cache: { control: headers["cache-control"] ?? null, ageHeaderPresent: headers.age !== undefined,
      etagPresent: headers.etag !== undefined, conditionalRequest: requestHeaders["if-none-match"] !== undefined
        || requestHeaders["if-modified-since"] !== undefined, fromServiceWorker: response.fromServiceWorker(), revalidated: response.status() === 304 } };
}

function summarizeAssets(rows) {
  const summary = {};
  for (const row of rows) {
    const item = summary[row.kind] ??= { count: 0, status200: 0, responseBodyBytes: 0 };
    item.count += 1;
    if (row.status === 200) item.status200 += 1;
    item.responseBodyBytes += row.responseBodyBytes ?? 0;
  }
  return summary;
}

function safeNetworkFailure(errorText) {
  if (typeof errorText === "string" && /^net::ERR_[A-Z0-9_]+$/.test(errorText)) return errorText.slice(5);
  return "other";
}

function classifySocketError(error) {
  if (error?.name === "TimeoutError" || error?.code === "ETIMEDOUT" || error?.code === "ESOCKETTIMEDOUT") return "timeout";
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(error?.code)) return "dns-error";
  if (error?.code === "ECONNREFUSED") return "refused";
  if (["ECONNRESET", "ECONNABORTED", "EPIPE"].includes(error?.code)) return "reset";
  if (["EHOSTUNREACH", "ENETUNREACH"].includes(error?.code)) return "unreachable";
  if (typeof error?.code === "string" && /(CERT|TLS_CERT|ALTNAME|VERIFY)/.test(error.code)) return "tls-certificate";
  if (error?.code === "EPROTO" || error?.code?.startsWith("ERR_TLS_")) return "tls-protocol";
  return "other";
}

async function probeIngressSocket(kind, address, port) {
  const startedAt = performance.now();
  return await new Promise(resolveProbe => {
    let settled = false;
    let socket;
    const finish = (status, extra = {}) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolveProbe({ status, elapsedMs: Math.round(performance.now() - startedAt), ...extra });
    };
    try {
      socket = kind === "tcp"
        ? createConnection({ host: address.address, family: address.family, port })
        : connectTls({ host: address.address, family: address.family, port, servername: PUBLIC_DOMAIN, rejectUnauthorized: true });
      socket.setTimeout(3_000, () => finish("timeout"));
      socket.once("error", error => finish(classifySocketError(error)));
      if (kind === "tcp") socket.once("connect", () => finish("connected"));
      else socket.once("secureConnect", () => finish(socket.authorized ? "verified" : "unverified", {
        authorized: Boolean(socket.authorized), protocol: socket.getProtocol() || null,
      }));
    } catch (error) {
      finish(classifySocketError(error));
    }
  });
}

async function probePublicIngressPorts() {
  const dnsStartedAt = performance.now();
  let dnsRows = [];
  let dnsStatus = "resolved";
  let dnsErrorClass = null;
  let timer;
  const dnsLookup = lookup(PUBLIC_DOMAIN, { all: true, verbatim: true })
    .then(rows => ({ rows }), error => ({ error }));
  const dnsTimeout = new Promise(resolveTimeout => {
    timer = setTimeout(() => resolveTimeout({ timeout: true }), 3_000);
    timer.unref?.();
  });
  const dnsResult = await Promise.race([dnsLookup, dnsTimeout]);
  clearTimeout(timer);
  const dnsElapsedMs = Math.round(performance.now() - dnsStartedAt);
  if (dnsResult.timeout) {
    dnsStatus = "timeout";
  } else if (dnsResult.error) {
    dnsStatus = "error";
    dnsErrorClass = classifySocketError(dnsResult.error);
  } else {
    dnsRows = dnsResult.rows;
    if (dnsRows.length === 0) dnsStatus = "empty";
  }
  const addresses = [];
  const seenFamilies = new Set();
  for (const row of dnsRows) {
    if (!seenFamilies.has(row.family)) {
      seenFamilies.add(row.family);
      addresses.push(row);
    }
    if (addresses.length >= 2) break;
  }
  const dns = { status: dnsStatus, errorClass: dnsErrorClass, elapsedMs: dnsElapsedMs,
    addressCount: dnsRows.length, families: [...new Set(dnsRows.map(row => row.family))].sort() };
  const ports = [];
  const portsToProbe = PUBLIC_PORT === 443 ? [443] : [TLS_PORT, 443];
  for (const port of portsToProbe) {
    const tcpAttempts = [];
    for (const address of addresses) {
      const result = await probeIngressSocket("tcp", address, port);
      tcpAttempts.push({ family: address.family, ...result });
      if (result.status === "connected") break;
    }
    const tcpStatus = tcpAttempts.find(row => row.status === "connected")?.status
      ?? tcpAttempts.at(-1)?.status ?? "not-attempted-no-address";
    const tlsAttempts = [];
    if (tcpStatus === "connected") {
      for (const address of addresses) {
        const result = await probeIngressSocket("tls", address, port);
        tlsAttempts.push({ family: address.family, ...result });
        if (result.status === "verified") break;
      }
    }
    const tlsStatus = tlsAttempts.find(row => row.status === "verified")?.status
      ?? tlsAttempts.at(-1)?.status ?? "not-attempted-no-tcp";
    ports.push({ port, dns, tcp: { status: tcpStatus, attempts: tcpAttempts }, tls: { status: tlsStatus, attempts: tlsAttempts } });
  }
  return { method: "direct socket and TLS handshake; no HTTP requests or credentials",
    totalElapsedMs: Math.round(performance.now() - dnsStartedAt), ports };
}

function safeFailureClass(error) {
  return ["AssertionError", "TimeoutError", "TypeError", "RangeError", "AbortError"].includes(error?.name) ? error.name : "Error";
}

function buildCaddyfile(gatewayId) {
  assert.match(gatewayId, /^[a-f0-9]{32}$/);
  const selected = "/g/" + gatewayId;
  return [
    "{",
    "  admin off",
    "  auto_https off",
    "}",
    "https://" + PUBLIC_DOMAIN + ":" + TLS_PORT + " {",
    "  tls " + CERT_PATH + " " + KEY_PATH,
    "  @relay path /_relay/register /_relay/control /_relay/data",
    "  reverse_proxy @relay 127.0.0.1:" + CONTROL_FORWARD_PORT + " {",
    "    header_up Host {http.request.hostport}",
    "    flush_interval -1",
    "  }",
    "  @selectedGateway path " + selected + " " + selected + "/*",
    "  reverse_proxy @selectedGateway 127.0.0.1:" + PROXY_FORWARD_PORT + " {",
    "    header_up Host {http.request.hostport}",
    "    flush_interval -1",
    "  }",
    "}",
    "",
  ].join("\n");
}

function buildProduction443RouteSnippet(runId, gatewayId) {
  assert.match(runId, /^[a-f0-9]{24}$/);
  assert.match(gatewayId, /^[a-f0-9]{32}$/);
  const matcher = "kcux_mobile_" + runId;
  const prefix = "/g/" + gatewayId;
  return [
    "  @" + matcher + " {",
    "    host " + PUBLIC_DOMAIN,
    "    path " + prefix + " " + prefix + "/*",
    "  }",
    "  handle @" + matcher + " {",
    "    reverse_proxy 127.0.0.1:" + PROXY_FORWARD_PORT + " {",
    "      header_up Host {http.request.hostport}",
    "      flush_interval -1",
    "    }",
    "  }",
    "",
  ].join("\n");
}

function remoteProductionCaddyIdentitySource() {
  return [
    "def _production_identity(pin,expected_config_sha):",
    " props=['MainPID','User','Group','ActiveState','SubState','ExecStart']",
    " unit=subprocess.run(['systemctl','show','caddy.service','--no-pager']+['--property='+x for x in props],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=5,check=False)",
    " values=dict(row.split('=',1) for row in unit.stdout.splitlines() if '=' in row)",
    " pid=int(values.get('MainPID','0')); assert unit.returncode==0 and pid==int(pin['pid']) and values.get('ActiveState')=='active' and values.get('SubState')=='running'",
    " assert values.get('User')=='caddy' and values.get('Group')=='caddy'",
    " proc=_read_process(pid); assert proc['euid']==" + CADDY_UID + " and proc['exe']==os.path.realpath(sys.argv[1])",
    " assert proc['argvSha256']==pin['argvSha256'] and proc['startTicks']==int(pin['startTicks']) and hashlib.sha256(open(proc['exe'],'rb').read()).hexdigest()==pin['exeSha256']",
    " config=next((proc['argv'][i+1] for i,x in enumerate(proc['argv'][:-1]) if x in ('--config','-config')),None)",
    " assert config==pin['configPath']=='/etc/caddy/Caddyfile' and os.path.realpath(config)==config",
    " raw,st=_read_owned_file(config,0,0,0o644)",
    " assert expected_config_sha is None or hashlib.sha256(raw).hexdigest()==expected_config_sha",
    " version=subprocess.run([sys.argv[1],'version'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=5,check=False)",
    " assert version.returncode==0 and version.stdout.strip().split()[0]==pin['version']=='" + CADDY_VERSION_PIN + "'",
    " return raw,st,pid,proc,values",
  ].join("\n");
}

function remoteProductionCaddyInstallSource() {
  return [
    "import hashlib,json,os,re,stat,subprocess,sys,time",
    productionAtomicFsCoreSource(),
    productionCandidateStageSource(),
    remoteProductionCaddyIdentitySource(),
    "assert os.geteuid()==0",
    "pin=json.loads(sys.argv[2]); run_id,gateway_id,snippet,expected_candidate_sha,backup_leaf,stage_leaf=sys.argv[3:]",
    "assert set(pin)=={'configPath','configSha256','pid','startTicks','argvSha256','exeSha256','version'}",
    "assert re.fullmatch(r'[a-f0-9]{24}',run_id) and re.fullmatch(r'[a-f0-9]{32}',gateway_id)",
    "assert backup_leaf=='.Caddyfile.kcux-'+run_id+'.backup' and stage_leaf=='.Caddyfile.kcux-'+run_id+'.stage'",
    "assert re.fullmatch(r'[a-f0-9]{64}',expected_candidate_sha)",
    "original,config_stat,pid,proc,unit_values=_production_identity(pin,pin['configSha256'])",
    "assert gateway_id.encode() not in original and run_id.encode() not in original",
    "lines=original.splitlines(keepends=True); offsets=[]; offset=0; anchors=[]",
    "for index,line in enumerate(lines):",
    " text=line.decode('utf-8','replace').strip()",
    " if text and not text.startswith('#'):",
    "  direct=bool(re.match(r'^@[A-Za-z0-9_-]+\\s+path\\s+/g/\\*(?:\\s|$)',text) or re.match(r'^(?:handle|handle_path)\\s+/g/\\*(?:\\s|$)',text))",
    "  block=bool(re.match(r'^path\\s+/g/\\*(?:\\s|$)',text))",
    "  if direct: anchors.append(offset)",
    "  elif block:",
    "   for previous in range(index-1,-1,-1):",
    "    prior=lines[previous].decode('utf-8','replace').strip()",
    "    if re.match(r'^@[A-Za-z0-9_-]+\\s*\\{\\s*$',prior): anchors.append(sum(len(row) for row in lines[:previous])); break",
    " offset+=len(line)",
    "assert len(anchors)==1",
    "candidate=original[:anchors[0]]+snippet.encode('utf-8')+original[anchors[0]:]",
    "assert hashlib.sha256(candidate).hexdigest()==expected_candidate_sha",
    "adapt=subprocess.run([sys.argv[1],'adapt','--config','/dev/stdin','--adapter','caddyfile'],input=candidate,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15,check=False)",
    "assert adapt.returncode==0 and isinstance(json.loads(adapt.stdout),dict)",
    "validate=subprocess.run([sys.argv[1],'validate','--config','/dev/stdin','--adapter','caddyfile'],input=candidate,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,check=False)",
    "assert validate.returncode==0",
    "directory=os.path.dirname(pin['configPath']); dirst=os.lstat(directory)",
    "assert stat.S_ISDIR(dirst.st_mode) and not stat.S_ISLNK(dirst.st_mode) and dirst.st_uid==0 and dirst.st_gid==0 and stat.S_IMODE(dirst.st_mode)&0o022==0",
    "dirfd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
    "try:",
    " _prepare_candidate_files(directory,dirfd,backup_leaf,stage_leaf,original,candidate,pin['configSha256'],expected_candidate_sha,0,0)",
    " final_guard=lambda: _production_identity(pin,pin['configSha256'])[:2]",
    " _commit_staged_config(dirfd,directory,stage_leaf,os.path.basename(pin['configPath']),expected_candidate_sha,pin['configSha256'],config_stat,0,0,0o644,final_guard)",
    "finally: os.close(dirfd)",
    "live,live_stat,pid_after,proc_after,values_after=_production_identity(pin,expected_candidate_sha)",
    "reload=subprocess.run(['systemctl','reload','caddy.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20,check=False)",
    "assert reload.returncode==0",
    "deadline=time.monotonic()+20",
    "while True:",
    " try: live,live_stat,pid_after,proc_after,values_after=_production_identity(pin,expected_candidate_sha); break",
    " except Exception:",
    "  if time.monotonic()>=deadline: raise",
    "  time.sleep(0.25)",
    "print(json.dumps({'installed':True,'reloaded':True,'configSha256':expected_candidate_sha,'originalSha256':pin['configSha256'],'backupLeaf':backup_leaf,'stageAbsent':not os.path.lexists(os.path.join(directory,stage_leaf)),'caddyPid':pid_after},separators=(',',':')))",
  ].join("\n");
}

function remoteProductionCaddyRestoreSource() {
  return [
    "import hashlib,json,os,re,stat,subprocess,sys,time",
    productionAtomicFsCoreSource(),
    remoteProductionCaddyIdentitySource(),
    "assert os.geteuid()==0",
    "pin=json.loads(sys.argv[2]); run_id,candidate_sha,original_sha,backup_leaf,candidate_stage_leaf,restore_stage_leaf=sys.argv[3:]",
    "assert set(pin)=={'configPath','configSha256','pid','startTicks','argvSha256','exeSha256','version'} and pin['configSha256']==original_sha",
    "assert re.fullmatch(r'[a-f0-9]{24}',run_id)",
    "assert backup_leaf=='.Caddyfile.kcux-'+run_id+'.backup' and candidate_stage_leaf=='.Caddyfile.kcux-'+run_id+'.stage' and restore_stage_leaf=='.Caddyfile.kcux-'+run_id+'.restore'",
    "assert re.fullmatch(r'[a-f0-9]{64}',candidate_sha) and re.fullmatch(r'[a-f0-9]{64}',original_sha)",
    "current,current_stat,pid,proc,values=_production_identity(pin,None)",
    "current_sha=hashlib.sha256(current).hexdigest(); assert current_sha in (candidate_sha,original_sha)",
    "backup_path=os.path.join(os.path.dirname(pin['configPath']),backup_leaf)",
    "candidate_stage_path=os.path.join(os.path.dirname(pin['configPath']),candidate_stage_leaf)",
    "restore_stage_path=os.path.join(os.path.dirname(pin['configPath']),restore_stage_leaf)",
    "if os.path.lexists(candidate_stage_path):",
    " candidate_stage,candidate_stage_stat=_read_owned_file(candidate_stage_path,0,0,0o644)",
    " assert hashlib.sha256(candidate_stage).hexdigest()==candidate_sha",
    "if os.path.lexists(backup_path):",
    " backup,backup_stat=_read_owned_file(backup_path,0,0,0o600); assert hashlib.sha256(backup).hexdigest()==original_sha",
    "else: assert current_sha==original_sha, 'original Caddy backup is required while candidate config remains installed'",
    "already_original=current_sha==original_sha and not os.path.lexists(backup_path) and not os.path.lexists(candidate_stage_path) and not os.path.lexists(restore_stage_path)",
    "if current_sha==candidate_sha:",
    " assert os.path.lexists(backup_path)",
    " final_guard=lambda: _production_identity(pin,candidate_sha)[:2]",
    " restored_stat=_restore_owned_config(pin['configPath'],backup_path,restore_stage_leaf,candidate_sha,original_sha,0,0,0o644,final_guard)",
    "else:",
    " restored,restored_stat=_read_owned_file(pin['configPath'],0,0,0o644); assert hashlib.sha256(restored).hexdigest()==original_sha",
    " assert ('kcux_mobile_'+run_id).encode() not in restored",
    "reloaded=False",
    "if not already_original:",
    " reload=subprocess.run(['systemctl','reload','caddy.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20,check=False); assert reload.returncode==0; reloaded=True",
    " deadline=time.monotonic()+20",
    " while True:",
    "  try:",
    "   restored,restored_stat,pid_after,proc_after,values_after=_production_identity(pin,original_sha); assert ('kcux_mobile_'+run_id).encode() not in restored; break",
    "  except Exception:",
    "   if time.monotonic()>=deadline: raise",
    "   time.sleep(0.25)",
    "else: restored,restored_stat,pid_after,proc_after,values_after=_production_identity(pin,original_sha)",
    "backup_removed=False",
    "if os.path.lexists(backup_path):",
    " backup,backup_stat=_read_owned_file(backup_path,0,0,0o600); assert hashlib.sha256(backup).hexdigest()==original_sha",
    " os.unlink(backup_path)",
    " dirfd=os.open(os.path.dirname(pin['configPath']),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
    " try: os.fsync(dirfd)",
    " finally: os.close(dirfd)",
    " backup_removed=True",
    "candidate_stage_removed=False",
    "if os.path.lexists(candidate_stage_path):",
    " candidate_stage,candidate_stage_stat=_read_owned_file(candidate_stage_path,0,0,0o644); assert hashlib.sha256(candidate_stage).hexdigest()==candidate_sha",
    " os.unlink(candidate_stage_path); dirfd=os.open(os.path.dirname(pin['configPath']),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
    " try: os.fsync(dirfd)",
    " finally: os.close(dirfd)",
    " candidate_stage_removed=True",
    "restore_stage_removed=False",
    "if os.path.lexists(restore_stage_path):",
    " restore_stage,restore_stage_stat=_read_owned_file(restore_stage_path,0,0,0o644); assert hashlib.sha256(restore_stage).hexdigest()==original_sha",
    " os.unlink(restore_stage_path); dirfd=os.open(os.path.dirname(pin['configPath']),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
    " try: os.fsync(dirfd)",
    " finally: os.close(dirfd)",
    " restore_stage_removed=True",
    "print(json.dumps({'restored':True,'reloaded':reloaded,'alreadyOriginal':already_original,'configSha256':original_sha,'backupRemoved':backup_removed,'candidateStageRemoved':candidate_stage_removed,'restoreStageRemoved':restore_stage_removed,'caddyPid':pid_after},separators=(',',':')))",
  ].join("\n");
}

async function runSyntheticCaddyAtomicRollbackFixture(context, snippet) {
  const fixtureRoot = context.pathInState("production-caddy-atomic-rollback-fixture");
  await mkdir(fixtureRoot, { recursive: false, mode: 0o700 });
  const configPath = join(fixtureRoot, "Caddyfile.synthetic");
  const backupPath = join(fixtureRoot, "Caddyfile.original");
  const stagedPath = join(fixtureRoot, "Caddyfile.staged");
  const restoreStagePath = join(fixtureRoot, "Caddyfile.restore-staged");
  const original = Buffer.from([
    ":443 {",
    "  handle /_relay/* { reverse_proxy 127.0.0.1:80 }",
    "  handle /g/* { reverse_proxy 127.0.0.1:80 }",
    "}",
    "",
  ].join("\n"));
  const anchor = Buffer.from("  handle /g/* {");
  assert.equal(original.indexOf(anchor), original.lastIndexOf(anchor));
  const anchorIndex = original.indexOf(anchor);
  const candidate = Buffer.concat([original.subarray(0, anchorIndex), Buffer.from(snippet), original.subarray(anchorIndex)]);
  const uid = process.getuid();
  const gid = process.getgid();
  const expectedMode = 0o600;
  const rootInfo = await lstat(fixtureRoot);
  assert.equal(rootInfo.isDirectory(), true);
  assert.equal(rootInfo.isSymbolicLink(), false);
  assert.equal(rootInfo.uid, uid);
  assert.equal(rootInfo.gid, gid);
  assert.equal(rootInfo.mode & 0o777, 0o700);
  await writeOwnedFixtureFile(configPath, original, expectedMode);
  await writeOwnedFixtureFile(backupPath, original, expectedMode);
  await writeOwnedFixtureFile(stagedPath, candidate, expectedMode);
  const originalMeta = await inspectOwnedFixtureFile(configPath, uid, gid, expectedMode);
  const backupMeta = await inspectOwnedFixtureFile(backupPath, uid, gid, expectedMode);
  assert.equal(backupMeta.sha256, originalMeta.sha256);
  const stagedMeta = await inspectOwnedFixtureFile(stagedPath, uid, gid, expectedMode);

  await rename(stagedPath, configPath);
  const replacedMeta = await inspectOwnedFixtureFile(configPath, uid, gid, expectedMode);
  assert.equal(replacedMeta.sha256, stagedMeta.sha256);

  await writeOwnedFixtureFile(restoreStagePath, await readFile(backupPath), expectedMode);
  const restoreMeta = await inspectOwnedFixtureFile(restoreStagePath, uid, gid, expectedMode);
  assert.equal(restoreMeta.sha256, originalMeta.sha256);
  await rename(restoreStagePath, configPath);
  const restoredMeta = await inspectOwnedFixtureFile(configPath, uid, gid, expectedMode);
  assert.equal(restoredMeta.sha256, originalMeta.sha256);
  assert.equal(restoredMeta.uid, originalMeta.uid);
  assert.equal(restoredMeta.gid, originalMeta.gid);
  assert.equal(restoredMeta.mode, originalMeta.mode);
  return {
    state: "PASS_SYNTHETIC_LOCAL_FIXTURE",
    scope: "same-owner RunContext directory only; does not prove /etc/caddy permissions or authorize production replacement",
    sameOwnerRunContextDirectory: true,
    replace: { atomicRename: true, originalSha256: originalMeta.sha256, candidateSha256: replacedMeta.sha256 },
    rollback: { backupSha256: backupMeta.sha256, atomicRename: true, restoredSha256: restoredMeta.sha256,
      restoredOwnerMode: restoredMeta.uid === uid && restoredMeta.gid === gid && restoredMeta.mode === expectedMode,
      restoredSingleLinkRegularFile: true },
  };
}

async function writeOwnedFixtureFile(path, bytes, mode) {
  await writeFile(path, bytes, { flag: "wx", mode });
  await chmod(path, mode);
}

async function inspectOwnedFixtureFile(path, uid, gid, mode) {
  const info = await lstat(path);
  assert.equal(info.isFile(), true);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(info.nlink, 1);
  assert.equal(info.uid, uid);
  assert.equal(info.gid, gid);
  assert.equal(info.mode & 0o777, mode);
  return { bytes: info.size, sha256: await shaFile(path), uid: info.uid, gid: info.gid, mode: info.mode & 0o777 };
}

function caddyCommand(root, action) {
  assert.ok(["validate"].includes(action));
  const envPrefix = "env XDG_CONFIG_HOME=" + shellQuote(root + "/config")
    + " XDG_DATA_HOME=" + shellQuote(root + "/data")
    + " PATH=/usr/bin:/bin";
  return "sudo -n -u caddy -- " + envPrefix + " " + shellQuote(CADDY_BIN)
    + " " + action + " --config " + shellQuote(root + "/Caddyfile") + " --adapter caddyfile";
}

function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }

const PRODUCTION_RUNNER_SOURCE = "apps/kcoder-studio/e2e/private/mobile-gateway-isolated-public-tls.once.e2e.mjs";
const PRODUCTION_RUN_ARTIFACT_ROOT = resolve(repoRoot, "target/test", PRODUCTION_RUNNER_SOURCE);

function productionRecoveryCommand(runRoot) {
  const config = process.env.KCODER_E2E_PUBLIC_SSH_CONFIG || "/home/hyf/.ssh/config";
  const knownHosts = process.env.KCODER_E2E_PUBLIC_SSH_KNOWN_HOSTS || "/home/hyf/.ssh/known_hosts";
  const target = process.env.KCODER_E2E_PUBLIC_SSH_TARGET;
  assert.ok(config.startsWith("/") && knownHosts.startsWith("/"));
  return "KCODER_E2E_ISOLATED_PUBLIC_TLS_MOBILE_ONCE= KCODER_E2E_PRODUCTION_CADDY_443_ONCE="
    + " KCODER_E2E_PUBLIC_SSH_CONFIG=" + shellQuote(config)
    + " KCODER_E2E_PUBLIC_SSH_KNOWN_HOSTS=" + shellQuote(knownHosts)
    + (target ? " KCODER_E2E_PUBLIC_SSH_TARGET=" + shellQuote(target) : "")
    + " " + EXPECTED_NODE + " " + resolve(repoRoot, PRODUCTION_RUNNER_SOURCE)
    + " --recover-production-caddy-443 " + shellQuote(runRoot);
}

function pythonCommand(source, args = [], { asCaddy = false, asRoot = false } = {}) {
  assert.equal(asCaddy && asRoot, false);
  const prefix = asRoot ? "sudo -n -- /usr/bin/python3 -c "
    : asCaddy ? "sudo -n -u caddy -- python3 -c " : "python3 -c ";
  return prefix + shellQuote(buildMarkedPythonSource(remoteOwnedProcessGuardSource() + "\n" + source))
    + (args.length ? " " + args.map(value => shellQuote(String(value))).join(" ") : "");
}

const remoteProductionRootProbeSource = () => ["import json,os", "assert os.geteuid()==0", "print(json.dumps({'euid':os.geteuid()},separators=(',',':')))"].join("\n");
const remoteSshIdentityProbeSource = () => ["import json,os,pwd", "print(json.dumps({'user':pwd.getpwuid(os.getuid()).pw_name,'euid':os.geteuid()},separators=(',',':')))"].join("\n");

function parseRemoteObject(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("owned remote operation did not return safe JSON"); }
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed;
}

function makeRemoteIo({ primary, recovery, dispatcher }) {
  let ordinal = 0;
  const runRemote = async (context, label, command, { timeoutMs = 25_000, maxStdoutBytes = 16_384, stdin } = {}) => {
    const id = String(++ordinal).padStart(4, "0");
    const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64);
    const result = await runOwnedSshOperation({ context, dispatcher,
      label: "iso-" + id + "-" + safeLabel, command, cwd: repoRoot, timeoutMs,
      maxStdoutBytes, maxStderrBytes: 32_768, stdin });
    await context.writeArtifactJson("isolated-ssh-stage-" + id + ".json", {
      label: safeLabel, outcome: "completed", markers: result.stage.markers.map(row => row.stage),
      stderrBytes: result.stderrBytes,
    });
    return result.stdout.toString("utf8").trim();
  };
  const output = (label, command, timeoutMs = 25_000) => runRemote(primary, label, command, { timeoutMs });
  const writeOwned = (label, command, bytes) => runRemote(primary, label, command, {
    timeoutMs: 25_000, maxStdoutBytes: 1024, stdin: bytes,
  });
  return {
    output,
    async verifyProductionRootInvocation() {
      const sshIdentity = parseRemoteObject(await output("verify-configured-ssh-account",
        pythonCommand(remoteSshIdentityProbeSource()), 10_000));
      assert.deepEqual(Object.keys(sshIdentity).sort(), ["euid", "user"]);
      assert.equal(sshIdentity.user, "admin");
      assert.notEqual(sshIdentity.euid, 0);
      const source = remoteProductionRootProbeSource();
      const result = parseRemoteObject(await output("verify-bounded-production-root-invocation",
        pythonCommand(source, [], { asRoot: true }), 10_000));
      assert.deepEqual(Object.keys(result), ["euid"]);
      assert.equal(result.euid, 0);
      return { ...result, sshUser: sshIdentity.user, sshEuid: sshIdentity.euid };
    },
    async preflight() {
      const requiredPorts = productionCaddy443Once
        ? [String(PROXY_FORWARD_PORT), String(CONTROL_FORWARD_PORT)]
        : [String(TLS_PORT), String(PROXY_FORWARD_PORT), String(CONTROL_FORWARD_PORT)];
      return parseRemoteObject(await output("isolated-tls-preflight", pythonCommand(remotePreflightSource(), [
        CERT_PATH, KEY_PATH, CADDY_BIN, String(CADDY_UID), ...requiredPorts, PUBLIC_DOMAIN,
      ], { asCaddy: true })));
    },
    async createRoot(transaction) {
      return parseRemoteObject(await output("create-owned-caddy-root", pythonCommand(remoteRootCreateSource(),
        [transaction.root, transaction.runId, transaction.marker], { asCaddy: true })));
    },
    async writeCaddyOwned(path, bytes) {
      const root = transactionRootFromPath(path);
      const digest = shaBytes(bytes);
      const written = await writeOwned("write-private-caddy-input", pythonCommand(remotePrivateWriteSource(),
        [root, path, digest, String(CADDY_UID)], { asCaddy: true }), bytes);
      assert.equal(written, "", "private remote file write must not echo candidate bytes");
    },
    async removeCaddyOwned(path) {
      const root = transactionRootFromPath(path);
      const digest = path.endsWith("server.mount-proof-check.mjs") ? RELAY_SERVER_PATCHED_SHA256 : null;
      assert.ok(digest);
      await output("remove-private-caddy-syntax-input", pythonCommand(remotePrivateUnlinkSource(),
        [root, path, digest, String(CADDY_UID)], { asCaddy: true }));
    },
    async verifyForwards(timeoutMs = 5_000) {
      const result = parseRemoteObject(await output("verify-ssh-reverse-forwards", pythonCommand(remoteForwardProbeSource(),
        [String(PROXY_FORWARD_PORT), String(CONTROL_FORWARD_PORT)]), timeoutMs));
      assert.deepEqual(Object.keys(result).sort(), ["controlForwardReachable", "proxyForwardReachable"]);
      assert.equal(typeof result.proxyForwardReachable, "boolean");
      assert.equal(typeof result.controlForwardReachable, "boolean");
      return result;
    },
    async readLoopbackTlsEntry(gatewayId) {
      assert.match(gatewayId, /^[a-f0-9]{32}$/);
      const result = parseRemoteObject(await output("probe-owned-tls-loopback-mobile-entry",
        pythonCommand(remoteLoopbackTlsEntrySource(), [PUBLIC_DOMAIN, String(PUBLIC_PORT), gatewayId], { asCaddy: true }), 10_000));
      assert.deepEqual(Object.keys(result).sort(), ["elapsedMs", "errorClass", "jsonContentType", "responseBytes", "schemaValid", "status", "tlsProtocol", "tlsVerified", "urlsMatchExpectedMount"]);
      assert.ok(result.status === null || Number.isInteger(result.status));
      for (const key of ["urlsMatchExpectedMount", "jsonContentType", "schemaValid", "tlsVerified"]) assert.equal(typeof result[key], "boolean");
      assert.ok(result.errorClass === null || ["tls-certificate", "tls-protocol", "timeout", "refused", "reset", "socket-error", "http-error", "other"].includes(result.errorClass));
      assert.ok(result.tlsProtocol === null || /^TLSv1\.[0-9]+$/.test(result.tlsProtocol));
      assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
      assert.ok(Number.isSafeInteger(result.responseBytes) && result.responseBytes >= 0 && result.responseBytes <= 16_385);
      return result;
    },
    async inspectProductionCandidate(runId, gatewayId, snippet) {
      const result = parseRemoteObject(await output("dry-run-exact-production-caddy-route",
        pythonCommand(remoteProductionCaddySnapshotSource(), [CADDY_BIN, JSON.stringify(PRODUCTION_CADDY_PIN), runId, gatewayId, snippet], { asCaddy: true }), 25_000));
      assert.equal(result.remoteWrites, false);
      assert.equal(result.serviceChanged, false);
      return result;
    },
    async installProductionRoute(transaction) {
      const backupLeaf = ".Caddyfile.kcux-" + transaction.runId + ".backup";
      const stageLeaf = ".Caddyfile.kcux-" + transaction.runId + ".stage";
      const result = parseRemoteObject(await output("install-exact-production-caddy-route", pythonCommand(remoteProductionCaddyInstallSource(), [
        CADDY_BIN, JSON.stringify(PRODUCTION_CADDY_PIN), transaction.runId, transaction.gatewayId,
        transaction.snippet, transaction.candidateConfigSha256, backupLeaf, stageLeaf,
      ], { asRoot: true }), 90_000));
      assert.deepEqual(Object.keys(result).sort(), ["backupLeaf", "caddyPid", "configSha256", "installed", "originalSha256", "reloaded", "stageAbsent"]);
      assert.equal(result.installed, true);
      assert.equal(result.reloaded, true);
      assert.equal(result.configSha256, transaction.candidateConfigSha256);
      assert.equal(result.originalSha256, PRODUCTION_CADDY_PIN.configSha256);
      assert.equal(result.backupLeaf, backupLeaf);
      assert.equal(result.stageAbsent, true);
      assert.equal(result.caddyPid, PRODUCTION_CADDY_PIN.pid);
      return result;
    },
    async restoreProductionRoute(transaction) {
      const backupLeaf = ".Caddyfile.kcux-" + transaction.runId + ".backup";
      const candidateStageLeaf = ".Caddyfile.kcux-" + transaction.runId + ".stage";
      const restoreStageLeaf = ".Caddyfile.kcux-" + transaction.runId + ".restore";
      const result = parseRemoteObject(await runRemote(recovery ?? primary, "restore-exact-production-caddy-config",
        pythonCommand(remoteProductionCaddyRestoreSource(), [CADDY_BIN, JSON.stringify(PRODUCTION_CADDY_PIN), transaction.runId,
          transaction.candidateConfigSha256, PRODUCTION_CADDY_PIN.configSha256, backupLeaf, candidateStageLeaf, restoreStageLeaf], { asRoot: true }),
        { timeoutMs: 90_000, maxStdoutBytes: 2048 }));
      assert.deepEqual(Object.keys(result).sort(), ["alreadyOriginal", "backupRemoved", "candidateStageRemoved", "caddyPid", "configSha256", "reloaded", "restoreStageRemoved", "restored"]);
      assert.equal(result.restored, true);
      assert.ok(result.reloaded === true || result.alreadyOriginal === true);
      assert.equal(result.configSha256, PRODUCTION_CADDY_PIN.configSha256);
      assert.equal(result.caddyPid, PRODUCTION_CADDY_PIN.pid);
      assert.equal(typeof result.candidateStageRemoved, "boolean");
      assert.equal(typeof result.restoreStageRemoved, "boolean");
      return result;
    },
    async inspectProductionInstalled() {
      return parseRemoteObject(await output("verify-exact-production-route-after-reload",
        pythonCommand(remoteProductionCaddySnapshotSource(), [CADDY_BIN], { asCaddy: true }), 25_000));
    },
    async startCaddy(transaction) {
      return parseRemoteObject(await output("start-owned-isolated-caddy", pythonCommand(remoteCaddyStartSource(),
        [transaction.root, transaction.runId, transaction.marker, transaction.configSha256, String(TLS_PORT), PUBLIC_DOMAIN,
          String(CADDY_UID), CADDY_BIN], { asCaddy: true }), 30_000));
    },
    async inspectCandidate(transaction) {
      return parseRemoteObject(await output("inspect-isolated-tls-listeners", pythonCommand(remoteCandidateInspectSource(),
        [transaction.root, transaction.runId, transaction.marker, String(TLS_PORT), String(PROXY_FORWARD_PORT),
          String(CONTROL_FORWARD_PORT), String(CADDY_UID), CADDY_BIN], { asCaddy: true })));
    },
    async stopCaddy(transaction) {
      return parseRemoteObject(await runRemote(recovery, "stop-owned-isolated-caddy",
        pythonCommand(remoteCaddyStopSource(), [transaction.root, transaction.runId, transaction.marker,
          String(CADDY_UID), CADDY_BIN], { asCaddy: true }), { timeoutMs: 35_000 }));
    },
    async removeRoot(transaction) {
      return parseRemoteObject(await runRemote(recovery, "remove-exact-owned-caddy-root",
        pythonCommand(remoteRootRemoveSource(), [transaction.root, transaction.runId, transaction.marker,
          String(CADDY_UID), CADDY_BIN, String(TLS_PORT), String(PROXY_FORWARD_PORT), String(CONTROL_FORWARD_PORT)],
          { asCaddy: true }), { timeoutMs: 30_000 }));
    },
    async verifyFinal(transaction) {
      return parseRemoteObject(await runRemote(recovery, "verify-owned-caddy-cleanup-terminal",
        pythonCommand(remoteFinalVerifySource(), [transaction.root, String(TLS_PORT), String(PROXY_FORWARD_PORT), String(CONTROL_FORWARD_PORT)],
          { asCaddy: true }), { timeoutMs: 15_000 }));
    },
  };
}

function transactionRootFromPath(path) {
  const match = /^\/tmp\/kc-mobile-isolated-tls-[a-f0-9]{24}\//.exec(path);
  assert.ok(match, "remote candidate path must stay inside this once-run root");
  return match[0].slice(0, -1);
}

function remotePreflightSource() {
  return [
    "import json,os,socket,ssl,stat,subprocess,sys,time",
    "cert,key,caddy,uid,*ports,domain=sys.argv[1:]",
    "uid=int(uid); ports=[int(x) for x in ports]",
    "def regular(path):",
    " st=os.lstat(path)",
    " assert stat.S_ISREG(st.st_mode) and not stat.S_ISLNK(st.st_mode) and st.st_uid==uid",
    " assert stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1",
    "regular(cert); regular(key)",
    "decoded=ssl._ssl._test_decode_cert(cert)",
    "sans=[name for kind,name in decoded.get('subjectAltName',[]) if kind=='DNS']",
    "assert domain in sans",
    "expiry=decoded['notAfter']",
    "assert ssl.cert_time_to_seconds(expiry)>time.time()",
    "states={}",
    "for port in ports:",
    " sock=socket.socket(socket.AF_INET,socket.SOCK_STREAM)",
    " try:",
    "  sock.bind(('0.0.0.0',port)); states[str(port)]='free'",
    " finally: sock.close()",
    "version=subprocess.check_output([caddy,'version'],stderr=subprocess.DEVNULL,text=True,timeout=5).split()[0]",
    "assert version==" + JSON.stringify(CADDY_VERSION_PIN),
    "print(json.dumps({'ports':states,'certificate':{'sanValid':True,'notAfter':expiry},'caddy':{'version':version}},separators=(',',':')))",
  ].join("\n");
}

function remoteRootCreateSource() {
  return [
    "import json,os,stat,sys",
    "root,run_id,marker=sys.argv[1:]",
    "assert run_id==marker and len(run_id)==24 and all(c in '0123456789abcdef' for c in run_id)",
    "assert root=='/tmp/kc-mobile-isolated-tls-'+run_id",
    "os.mkdir(root,0o700); st=os.lstat(root)",
    "assert stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode) and st.st_uid==os.geteuid() and stat.S_IMODE(st.st_mode)==0o700",
    "owner={'version':1,'runId':run_id,'uid':st.st_uid,'dev':st.st_dev,'ino':st.st_ino}",
    "path=os.path.join(root,'.owner.json'); fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)",
    "try:",
    " body=(json.dumps(owner,separators=(',',':'))+'\\n').encode(); os.write(fd,body); os.fsync(fd)",
    "finally: os.close(fd)",
    "for name in ('config','data','tmp'):",
    " os.mkdir(os.path.join(root,name),0o700)",
    "print(json.dumps({'dev':st.st_dev,'ino':st.st_ino,'uid':st.st_uid,'mode':stat.S_IMODE(st.st_mode)},separators=(',',':')))",
  ].join("\n");
}

function remotePrivateWriteSource() {
  return [
    "import hashlib,os,stat,sys",
    "root,path,digest,uid=sys.argv[1:]; uid=int(uid)",
    "run_id=os.path.basename(root).removeprefix('kc-mobile-isolated-tls-')",
    "_read_owner_marker(root,run_id,'.owner.json',uid)",
    "assert os.path.dirname(path)==root and os.path.basename(path) in ('Caddyfile','server.mount-proof-check.mjs')",
    "data=sys.stdin.buffer.read(2*1024*1024+1); assert len(data)<=2*1024*1024",
    "assert hashlib.sha256(data).hexdigest()==digest",
    "fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)",
    "try:",
    " view=memoryview(data)",
    " while view:",
    "  count=os.write(fd,view); assert count>0; view=view[count:]",
    " os.fsync(fd); st=os.fstat(fd)",
    " assert stat.S_ISREG(st.st_mode) and st.st_uid==uid and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1",
    "finally: os.close(fd)",
  ].join("\n");
}

function remotePrivateUnlinkSource() {
  return [
    "import hashlib,os,stat,sys",
    "root,path,digest,uid=sys.argv[1:]; uid=int(uid)",
    "run_id=os.path.basename(root).removeprefix('kc-mobile-isolated-tls-')",
    "_read_owner_marker(root,run_id,'.owner.json',uid)",
    "assert path==os.path.join(root,'server.mount-proof-check.mjs')",
    "st=_private_regular(path,uid,0o600); assert st.st_size<=2*1024*1024",
    "fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)",
    "try:",
    " opened=os.fstat(fd); assert (opened.st_dev,opened.st_ino)==(st.st_dev,st.st_ino)",
    " h=hashlib.sha256()",
    " for chunk in iter(lambda:os.read(fd,1024*1024),b''): h.update(chunk)",
    " assert h.hexdigest()==digest",
    "finally: os.close(fd)",
    "os.unlink(path)",
    "print('{\"removed\":true}')",
  ].join("\n");
}

function remoteForwardProbeSource() {
  return [
    "import json,socket,sys",
    "ports=[int(x) for x in sys.argv[1:]]",
    "result={}",
    "for port in ports:",
    " sock=socket.socket(socket.AF_INET,socket.SOCK_STREAM); sock.settimeout(2)",
    " try: result[str(port)]=sock.connect_ex(('127.0.0.1',port))==0",
    " finally: sock.close()",
    "print(json.dumps({'proxyForwardReachable':result[str(ports[0])],'controlForwardReachable':result[str(ports[1])]},separators=(',',':')))",
  ].join("\n");
}

function remoteLoopbackTlsEntrySource() {
  return [
    "import http.client,json,socket,ssl,sys,time",
    "domain,raw_port,gateway_id=sys.argv[1:]; port=int(raw_port)",
    "result={'status':None,'tlsVerified':False,'tlsProtocol':None,'schemaValid':False,'urlsMatchExpectedMount':False,'jsonContentType':False,'responseBytes':0,'elapsedMs':None,'errorClass':None}",
    "class LoopbackTLS(http.client.HTTPSConnection):",
    " def connect(self):",
    "  raw=socket.create_connection(('127.0.0.1',port),timeout=5)",
    "  self.sock=self._context.wrap_socket(raw,server_hostname=domain)",
    "started=time.monotonic(); conn=None",
    "try:",
    " context=ssl.create_default_context()",
    " conn=LoopbackTLS(domain,port,context=context,timeout=5)",
    " path='/g/'+gateway_id+'/mobile-entry'",
    " conn.request('GET',path,headers={'Host':domain+':'+str(port),'Accept':'application/json','Cache-Control':'no-store','Connection':'close'})",
    " result['tlsVerified']=bool(conn.sock and conn.sock.version() and conn.sock.context.check_hostname and conn.sock.context.verify_mode==ssl.CERT_REQUIRED)",
    " result['tlsProtocol']=conn.sock.version() if conn.sock else None",
    " response=conn.getresponse()",
    " result['status']=response.status",
    " result['jsonContentType']=response.getheader('content-type','').split(';',1)[0].strip().lower()=='application/json'",
    " body=response.read(16385); result['responseBytes']=len(body)",
    " if len(body)<=16384:",
    "  try: value=json.loads(body.decode('utf-8'))",
    "  except (UnicodeDecodeError,json.JSONDecodeError): value=None",
    "  if type(value) is dict and set(value)=={'available','gatewayUrl','mobileUrl','version'}:",
    "   authority=domain+(':'+str(port) if port!=443 else '')",
    "   expected_mobile='https://'+authority+'/g/'+gateway_id+'/mobile/'",
    "   expected_gateway='https://'+authority+'/g/'+gateway_id",
    "   result['urlsMatchExpectedMount']=value.get('mobileUrl')==expected_mobile and value.get('gatewayUrl')==expected_gateway",
    "   result['schemaValid']=value.get('version')==1 and value.get('available') is True and result['urlsMatchExpectedMount']",
    "except ssl.SSLCertVerificationError:",
    " result['errorClass']='tls-certificate'",
    "except ssl.SSLError:",
    " result['errorClass']='tls-protocol'",
    "except socket.timeout:",
    " result['errorClass']='timeout'",
    "except ConnectionRefusedError:",
    " result['errorClass']='refused'",
    "except ConnectionResetError:",
    " result['errorClass']='reset'",
    "except OSError:",
    " result['errorClass']='socket-error'",
    "except http.client.HTTPException:",
    " result['errorClass']='http-error'",
    "except Exception:",
    " result['errorClass']='other'",
    "finally:",
    " if conn is not None: conn.close()",
    " result['elapsedMs']=round((time.monotonic()-started)*1000,2)",
    "print(json.dumps(result,separators=(',',':')))"
  ].join("\n");
}

function remoteCaddyStartSource() {
  return [
    "import hashlib,json,os,signal,socket,ssl,stat,subprocess,sys,time",
    "root,run_id,marker,config_sha,port,domain,uid,executable=sys.argv[1:]",
    "uid=int(uid); port=int(port); assert run_id==marker",
    "rs,_=_read_owner_marker(root,run_id,'.owner.json',uid)",
    "config=os.path.join(root,'Caddyfile'); st=_private_regular(config,uid,0o600)",
    "digest=hashlib.sha256(open(config,'rb').read()).hexdigest(); assert digest==config_sha",
    "intent={'runId':run_id,'configSha256':config_sha,'rootDev':rs.st_dev,'rootIno':rs.st_ino}",
    "intent_path=os.path.join(root,'.launch-intent.json')",
    "def write_once(path,value):",
    " fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)",
    " try:",
    "  body=(json.dumps(value,separators=(',',':'))+'\\n').encode(); view=memoryview(body)",
    "  while view:",
    "   n=os.write(fd,view); assert n>0; view=view[n:]",
    "  os.fsync(fd)",
    " finally: os.close(fd)",
    " dirfd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
    " try: os.fsync(dirfd)",
    " finally: os.close(dirfd)",
    "write_once(intent_path,intent)",
    "def write_launch_failed(state,pid=None,exit_code=None):",
    " assert not os.path.lexists(os.path.join(root,'.caddy-owner.json'))",
    " failed={'runId':run_id,'configSha256':config_sha,'rootDev':rs.st_dev,'rootIno':rs.st_ino,",
    "  'state':state,'pid':pid,'exitCode':exit_code}",
    " assert state in ('spawn-failed','child-stopped-before-owner')",
    " write_once(os.path.join(root,'.launch-failed.json'),failed)",
    "log_path=os.path.join(root,'caddy.log')",
    "log_fd=os.open(log_path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)",
    "env={'PATH':'/usr/bin:/bin','XDG_CONFIG_HOME':os.path.join(root,'config'),'XDG_DATA_HOME':os.path.join(root,'data'),'TMPDIR':os.path.join(root,'tmp')}",
    "argv=[executable,'run','--config',config,'--adapter','caddyfile']",
    "proc=None; receipt_written=False",
    "try:",
    " try: proc=subprocess.Popen(argv,cwd=root,env=env,stdin=subprocess.DEVNULL,stdout=log_fd,stderr=log_fd,close_fds=True,start_new_session=True)",
    " except OSError:",
    "  write_launch_failed('spawn-failed')",
    "  raise",
    " deadline=time.monotonic()+8",
    " while time.monotonic()<deadline:",
    "  if proc.poll() is not None: raise RuntimeError('candidate exited before owner receipt')",
    "  try: actual=_read_process(proc.pid)",
    "  except (FileNotFoundError,ProcessLookupError): time.sleep(0.05); continue",
    "  if actual['exe']==os.path.realpath(executable) and actual['argv']==argv: break",
    "  time.sleep(0.05)",
    " else: raise RuntimeError('candidate owner identity was not established')",
    " owner={'runId':run_id,'pid':actual['pid'],'startTicks':actual['startTicks'],'euid':actual['euid'],'exe':actual['exe'],",
    "  'argvSha256':actual['argvSha256'],'cwd':actual['cwd'],'configSha256':config_sha}",
    " owner_path=os.path.join(root,'.caddy-owner.json')",
    " write_once(owner_path,owner); receipt_written=True",
    " deadline=time.monotonic()+15; context=ssl.create_default_context(); ready=False",
    " while time.monotonic()<deadline:",
    "  try:",
    "   sock=socket.create_connection(('127.0.0.1',port),timeout=1)",
    "   tls=context.wrap_socket(sock,server_hostname=domain); tls.close(); ready=True; break",
    "  except (OSError,ssl.SSLError):",
    "   if proc.poll() is not None: break",
    "   time.sleep(0.1)",
    " assert ready",
    " assert_owned_process(owner,root,run_id,'.owner.json',uid,executable,config_sha,argv)",
    " print(json.dumps({'pid':owner['pid'],'ready':True},separators=(',',':')))",
    "except BaseException:",
    " if proc is not None and not receipt_written:",
    "  try:",
    "   if proc.poll() is None:",
    "    try: proc.terminate()",
    "    except ProcessLookupError: pass",
    "   try: exit_code=proc.wait(timeout=3)",
    "   except subprocess.TimeoutExpired:",
    "    proc.kill(); exit_code=proc.wait(timeout=3)",
    "   if exit_code is not None: write_launch_failed('child-stopped-before-owner',proc.pid,exit_code)",
    "  except BaseException: pass",
    " raise",
    "finally: os.close(log_fd)",
  ].join("\n");
}

function remoteCandidateInspectSource() {
  return [
    "import hashlib,json,os,socket,sys",
    "root,run_id,marker,tls,proxy,control,uid,executable=sys.argv[1:]",
    "tls,proxy,control,uid=map(int,(tls,proxy,control,uid))",
    "_read_owner_marker(root,run_id,'.owner.json',uid)",
    "config=os.path.join(root,'Caddyfile'); config_sha=hashlib.sha256(open(config,'rb').read()).hexdigest()",
    "owner=_read_owned_json(root,'.caddy-owner.json',uid,2048)",
    "argv=[executable,'run','--config',config,'--adapter','caddyfile']",
    "assert_owned_process(owner,root,run_id,'.owner.json',uid,executable,config_sha,argv)",
    "def can_connect(port):",
    " sock=socket.socket(socket.AF_INET,socket.SOCK_STREAM); sock.settimeout(2)",
    " try: return sock.connect_ex(('127.0.0.1',port))==0",
    " finally: sock.close()",
    "assert run_id==marker",
    "print(json.dumps({'caddyOwnsTlsPort':can_connect(tls),'proxyForwardReachable':can_connect(proxy),",
    " 'controlForwardReachable':can_connect(control)},separators=(',',':')))",
  ].join("\n");
}

function remoteCaddyStopSource() {
  return [
    "import hashlib,json,os,select,signal,sys",
    "root,run_id,marker,uid,executable=sys.argv[1:]; uid=int(uid); assert run_id==marker",
    "rs,_=_read_owner_marker(root,run_id,'.owner.json',uid)",
    "intent=_read_owned_json(root,'.launch-intent.json',uid,2048)",
    "assert set(intent)=={'runId','configSha256','rootDev','rootIno'} and intent['runId']==run_id",
    "assert intent['rootDev']==rs.st_dev and intent['rootIno']==rs.st_ino",
    "config=os.path.join(root,'Caddyfile'); _private_regular(config,uid,0o600)",
    "config_sha=hashlib.sha256(open(config,'rb').read()).hexdigest()",
    "assert config_sha==intent['configSha256'] and len(config_sha)==64 and all(c in '0123456789abcdef' for c in config_sha)",
    "argv=[executable,'run','--config',config,'--adapter','caddyfile']",
    "def write_stopped(state):",
    " stopped={'runId':run_id,'pid':owner['pid'],'startTicks':owner['startTicks'],'state':state}",
    " path=os.path.join(root,'.caddy-stopped.json'); w=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)",
    " try:",
    "  body=(json.dumps(stopped,separators=(',',':'))+'\\n').encode(); view=memoryview(body)",
    "  while view:",
    "   n=os.write(w,view); assert n>0; view=view[n:]",
    "  os.fsync(w)",
    " finally: os.close(w)",
    " dirfd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
    " try: os.fsync(dirfd)",
    " finally: os.close(dirfd)",
    "owner_path=os.path.join(root,'.caddy-owner.json'); failed_path=os.path.join(root,'.launch-failed.json')",
    "if not os.path.lexists(owner_path):",
    " failed=_read_owned_json(root,'.launch-failed.json',uid,2048)",
    " assert set(failed)=={'runId','configSha256','rootDev','rootIno','state','pid','exitCode'}",
    " assert failed['runId']==run_id and failed['configSha256']==config_sha and failed['rootDev']==rs.st_dev and failed['rootIno']==rs.st_ino",
    " if failed['state']=='spawn-failed': assert failed['pid'] is None and failed['exitCode'] is None",
    " else: assert failed['state']=='child-stopped-before-owner' and type(failed['pid']) is int and failed['pid']>1 and type(failed['exitCode']) is int",
    " print(json.dumps({'stopped':True,'state':failed['state']},separators=(',',':'))) ",
    "else:",
    " assert not os.path.lexists(failed_path), 'owner and launch-failed receipts cannot coexist'",
    " owner=_read_owned_json(root,'.caddy-owner.json',uid,2048)",
    " assert set(owner)=={'runId','pid','startTicks','euid','exe','argvSha256','cwd','configSha256'}",
    " assert owner['runId']==run_id and owner['configSha256']==config_sha and owner['cwd']==root and owner['exe']==os.path.realpath(executable)",
    " assert type(owner['pid']) is int and owner['pid']>1 and type(owner['startTicks']) is int and owner['startTicks']>0",
    " try: actual=_read_process(owner['pid'])",
    " except FileNotFoundError:",
    "  write_stopped('owner-exited-before-cleanup')",
    "  stopped_state='owner-exited-before-cleanup'",
    " else:",
    "  assert actual['startTicks']==owner['startTicks'], 'owned PID was reused; refusing cleanup'",
    "  assert_owned_process(owner,root,run_id,'.owner.json',uid,executable,config_sha,argv)",
    "  try: fd=os.pidfd_open(owner['pid'],0)",
    "  except ProcessLookupError:",
    "   try: _read_process(owner['pid'])",
    "   except FileNotFoundError:",
    "    write_stopped('owner-exited-before-cleanup')",
    "    stopped_state='owner-exited-before-cleanup'",
    "   else: raise AssertionError('owned process identity changed while opening pidfd')",
    "  else:",
    "   try:",
    "    assert_owned_process(owner,root,run_id,'.owner.json',uid,executable,config_sha,argv)",
    "    signal.pidfd_send_signal(fd,signal.SIGTERM)",
    "    poller=select.poll(); poller.register(fd,select.POLLIN)",
    "    events=poller.poll(20000); assert events",
    "   finally: os.close(fd)",
    "   write_stopped('pidfd-exited'); stopped_state='pidfd-exited'",
    " print(json.dumps({'stopped':True,'state':stopped_state},separators=(',',':'))) ",
  ].join("\n");
}

function remoteRootRemoveSource() {
  return [
    "import hashlib,json,os,shutil,socket,sys",
    "root,run_id,marker,uid,executable,*raw_ports=sys.argv[1:]",
    "uid=int(uid); ports=[int(x) for x in raw_ports]; assert run_id==marker",
    "rs,_=_read_owner_marker(root,run_id,'.owner.json',uid)",
    "intent_path=os.path.join(root,'.launch-intent.json'); owner_path=os.path.join(root,'.caddy-owner.json')",
    "if os.path.lexists(intent_path):",
    " intent=_read_owned_json(root,'.launch-intent.json',uid,2048)",
    " assert set(intent)=={'runId','configSha256','rootDev','rootIno'} and intent['runId']==run_id",
    " assert type(intent['configSha256']) is str and len(intent['configSha256'])==64 and all(c in '0123456789abcdef' for c in intent['configSha256'])",
    " assert intent['rootDev']==rs.st_dev and intent['rootIno']==rs.st_ino",
    " config=os.path.join(root,'Caddyfile'); _private_regular(config,uid,0o600)",
    " assert hashlib.sha256(open(config,'rb').read()).hexdigest()==intent['configSha256']",
    " if os.path.lexists(owner_path):",
    "  assert not os.path.lexists(os.path.join(root,'.launch-failed.json'))",
    "  owner=_read_owned_json(root,'.caddy-owner.json',uid,2048)",
    "  assert set(owner)=={'runId','pid','startTicks','euid','exe','argvSha256','cwd','configSha256'}",
    "  assert owner['configSha256']==intent['configSha256'] and owner['runId']==run_id",
    "  assert owner['cwd']==root and owner['exe']==os.path.realpath(executable) and owner['euid']==uid",
    "  assert type(owner['pid']) is int and owner['pid']>1 and type(owner['startTicks']) is int and owner['startTicks']>0",
    "  stopped=_read_owned_json(root,'.caddy-stopped.json',uid,2048)",
    "  assert stopped=={'runId':run_id,'pid':owner['pid'],'startTicks':owner['startTicks'],'state':stopped['state']} and stopped['state'] in ('pidfd-exited','owner-exited-before-cleanup')",
    " else:",
    "  failed=_read_owned_json(root,'.launch-failed.json',uid,2048)",
    "  assert set(failed)=={'runId','configSha256','rootDev','rootIno','state','pid','exitCode'}",
    "  assert failed['runId']==run_id and failed['configSha256']==intent['configSha256'] and failed['rootDev']==rs.st_dev and failed['rootIno']==rs.st_ino",
    "  if failed['state']=='spawn-failed': assert failed['pid'] is None and failed['exitCode'] is None",
    "  else: assert failed['state']=='child-stopped-before-owner' and type(failed['pid']) is int and failed['pid']>1 and type(failed['exitCode']) is int",
    "else: assert not any(os.path.lexists(os.path.join(root,name)) for name in ('.launch-failed.json','.caddy-owner.json','.caddy-stopped.json'))",
    "def free(port):",
    " sock=socket.socket(socket.AF_INET,socket.SOCK_STREAM)",
    " try:",
    "  sock.bind(('0.0.0.0',port)); return True",
    " except OSError: return False",
    " finally: sock.close()",
    "assert all(free(port) for port in ports), 'candidate listener or reverse forward remains'",
    "assert shutil.rmtree.avoids_symlink_attacks",
    "allowed={'.owner.json','.launch-intent.json','.launch-failed.json','.caddy-owner.json','.caddy-stopped.json','Caddyfile','caddy.log','server.mount-proof-check.mjs','config','data','tmp'}",
    "_assert_owned_tree(root,uid,allowed,256,8*1024*1024)",
    "shutil.rmtree(root)",
    "print(json.dumps({'removed':True,'rootAbsent':not os.path.lexists(root),'portsFree':ports},separators=(',',':')))",
  ].join("\n");
}

function remoteFinalVerifySource() {
  return [
    "import json,os,socket,sys",
    "root,*raw_ports=sys.argv[1:]; ports=[int(x) for x in raw_ports]",
    "def free(port):",
    " sock=socket.socket(socket.AF_INET,socket.SOCK_STREAM)",
    " try: sock.bind(('0.0.0.0',port)); return True",
    " except OSError: return False",
    " finally: sock.close()",
    "states=[free(port) for port in ports]",
    "print(json.dumps({'rootAbsent':not os.path.lexists(root),'portsFree':all(states),'portStates':states},separators=(',',':')))",
  ].join("\n");
}

function remoteProductionCaddySnapshotSource() {
  return [
    "import hashlib,json,os,re,shlex,socket,subprocess,sys",
    "props=['MainPID','FragmentPath','User','Group','ActiveState','SubState','ExecStart','ExecReload','EnvironmentFiles','RootDirectory','RootImage','BindPaths','BindReadOnlyPaths','PrivateMounts','ProtectSystem','ReadWritePaths','ReadOnlyPaths','InaccessiblePaths','PrivateTmp','PrivateDevices','ProtectHome','NoNewPrivileges']",
    "systemd=subprocess.run(['systemctl','show','caddy.service','--no-pager']+['--property='+key for key in props],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=5,check=False)",
    "values=dict(line.split('=',1) for line in systemd.stdout.splitlines() if '=' in line)",
    "pid=int(values.get('MainPID','0'))",
    "assert systemd.returncode==0 and pid>1",
    "proc='/proc/'+str(pid)",
    "argv=[part.decode('utf-8','replace') for part in open(proc+'/cmdline','rb').read().split(b'\\0') if part]",
    "binary=os.path.realpath(sys.argv[1]); argv0=os.path.realpath(argv[0]); assert argv0==binary",
    "exe=binary",
    "with open(binary,'rb') as f: exe_sha=hashlib.sha256(f.read()).hexdigest()",
    "status=open(proc+'/status',encoding='utf-8').read()",
    "euid=int(re.search(r'^Uid:\\s+\\d+\\s+(\\d+)',status,re.M).group(1))",
    "stat_text=open(proc+'/stat',encoding='utf-8').read(); stat_tail=stat_text[stat_text.rfind(')')+2:].split()",
    "start_ticks=int(stat_tail[19])",
    "argv_sha=hashlib.sha256(open(proc+'/cmdline','rb').read()).hexdigest()",
    "def arg_value(args,name):",
    " for i,value in enumerate(args):",
    "  if value==name and i+1<len(args): return args[i+1]",
    "  if value.startswith(name+'='): return value.split('=',1)[1]",
    " return None",
    "config=arg_value(argv,'--config') or arg_value(argv,'-config')",
    "adapter=arg_value(argv,'--adapter') or arg_value(argv,'-adapter') or 'caddyfile'",
    "assert config and os.path.isabs(config) and os.path.isfile(config)",
    "config_stat=os.stat(config)",
    "config_hash=hashlib.sha256(open(config,'rb').read()).hexdigest()",
    "config_bytes=open(config,'rb').read()",
    "version_run=subprocess.run([sys.argv[1],'version'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=5,check=False)",
    "version=version_run.stdout.strip().split()[0] if version_run.returncode==0 and version_run.stdout.strip() else None",
    "adapt=subprocess.run([sys.argv[1],'adapt','--config',config,'--adapter',adapter,'--pretty'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=12,check=False)",
    "adapted=None",
    "if adapt.returncode==0:",
    " try: adapted=json.loads(adapt.stdout)",
    " except Exception: adapted=None",
    "def normalize_path(value): return re.sub(r'(/g/)[0-9a-fA-F]{32}(?=/|$)',r'\\1<ID>',str(value))",
    "def get_paths(matchers):",
    " out=[]",
    " for matcher in matchers or []:",
    "  if isinstance(matcher,dict) and isinstance(matcher.get('path'),list): out.extend(normalize_path(v) for v in matcher['path'] if isinstance(v,str))",
    " return out",
    "def get_hosts(matchers):",
    " out=[]",
    " for matcher in matchers or []:",
    "  if isinstance(matcher,dict) and isinstance(matcher.get('host'),list): out.extend(v for v in matcher['host'] if isinstance(v,str))",
    " return out",
    "def relevant(paths): return any(p.startswith('/g/') or p.startswith('/_relay/') for p in paths)",
    "def dials(handler):",
    " out=[]",
    " for upstream in handler.get('upstreams',[]) if isinstance(handler,dict) else []:",
    "  dial=upstream.get('dial') if isinstance(upstream,dict) else None",
    "  if isinstance(dial,str):",
    "   host,sep,port=dial.rpartition(':'); out.append({'loopback':host in ('127.0.0.1','[::1]','localhost'),'port':port if sep and port.isdigit() else None})",
    " return out",
    "def project_routes(document):",
    " rows=[]",
    " def visit(route,server_name,server_listen,route_path,parent_match=None):",
    "  match=(parent_match or [])+(route.get('match') or [])",
    "  paths=get_paths(match); hosts=get_hosts(match); handles=route.get('handle') or []",
    "  if relevant(paths):",
    "   for handler in handles:",
    "    if not isinstance(handler,dict): continue",
    "    kind=handler.get('handler','unknown')",
    "    if kind=='subroute':",
    "     for index,child in enumerate(handler.get('routes') or []): visit(child,server_name,server_listen,route_path+'.'+str(index),match)",
    "    else:",
    "     entry={'server':server_name,'listen':server_listen,'order':route_path,'hosts':hosts,'paths':paths,'handler':kind}",
    "     if kind=='reverse_proxy':",
    "      entry['upstreams']=dials(handler); headers=handler.get('headers',{}).get('request',{}).get('set',{}) if isinstance(handler.get('headers'),dict) else {}",
    "      entry['hostHeaderSet']=any(str(k).lower()=='host' for k in headers) if isinstance(headers,dict) else False",
    "      entry['flushInterval']=handler.get('flush_interval')",
    "     elif kind=='rewrite': entry['pathTransformPresent']=any(k in handler for k in ('strip_path_prefix','strip_path_suffix','uri','path_regexp'))",
    "     rows.append(entry)",
    "  else:",
    "   for handler in handles:",
    "    if isinstance(handler,dict) and handler.get('handler')=='subroute':",
    "     for index,child in enumerate(handler.get('routes') or []): visit(child,server_name,server_listen,route_path+'.'+str(index),match)",
    " if document:",
    "  for server_name,server in (document.get('apps',{}).get('http',{}).get('servers',{}) or {}).items():",
    "   for index,route in enumerate(server.get('routes') or []): visit(route,server_name,server.get('listen') or [],str(index))",
    " return rows",
    "route_rows=project_routes(adapted)",
    "admin=adapted.get('admin') if isinstance(adapted,dict) else None",
    "admin=admin if isinstance(admin,dict) else {}",
    "admin_disabled=bool(admin.get('disabled',False))",
    "admin_listen=admin.get('listen') or ('disabled' if admin_disabled else 'localhost:2019')",
    "admin_host,admin_sep,admin_port=str(admin_listen).rpartition(':')",
    "admin_port=int(admin_port) if admin_sep and admin_port.isdigit() else None",
    "admin_loopback=admin_disabled or admin_host in ('localhost','127.0.0.1','::1','[::1]')",
    "admin_reachable=False",
    "if not admin_disabled and admin_port and admin_loopback:",
    " try:",
    "  with socket.create_connection(('127.0.0.1',admin_port),timeout=0.4): admin_reachable=True",
    " except OSError: pass",
    "candidate_review={'requested':False}",
    "if len(sys.argv)==6:",
    " pin=json.loads(sys.argv[2]); run_id,gateway_id,snippet=sys.argv[3:6]",
    " assert set(pin)=={'configPath','configSha256','pid','startTicks','argvSha256','exeSha256','version'}",
    " candidate_review={'requested':True,'guards':{'configSha256':config_hash==pin['configSha256'],'configPath':config==pin['configPath'],'configRegularSingleLink':os.path.isfile(config) and config_stat.st_nlink==1,'configOwnerMode':(config_stat.st_uid,config_stat.st_gid,config_stat.st_mode&0o777)==(0,0,0o644),'process':pid==int(pin['pid']) and start_ticks==int(pin['startTicks']) and argv_sha==pin['argvSha256'],'binarySha256':exe_sha==pin['exeSha256'],'version':version==pin['version']},'syntheticGatewayId':gateway_id,'runId':run_id,'candidateAdaptExitCode':None,'candidateAdaptJsonValid':False,'routeAssertionsPass':False,'insertionAnchorCount':0,'routeDelta':{'added':[],'removed':[]},'selectedBeforeCatchall':False,'selectedOrder':None,'catchallBeforeOrder':None,'catchallAfterOrder':None,'relayUnchanged':False,'catchallUnchanged':False,'otherRoutesUnchanged':False,'candidateConfigSha256':None,'productionConfigAfterSha256':None,'productionConfigUnchanged':False,'snippetSha256':hashlib.sha256(snippet.encode()).hexdigest()} ",
    " assert re.fullmatch(r'[a-f0-9]{24}',run_id) and re.fullmatch(r'[a-f0-9]{32}',gateway_id)",
    " candidate_review['guardFailureKeys']=[key for key,value in candidate_review['guards'].items() if not value]",
    " candidate_review['guardsPass']=not candidate_review['guardFailureKeys']",
    "if candidate_review['requested'] and candidate_review['guardsPass']:",
    " assert gateway_id.encode() not in config_bytes,'synthetic gateway ID already occurs in current Caddyfile'",
    " snippet_bytes=snippet.encode('utf-8'); lines=config_bytes.splitlines(keepends=True); offsets=[]; offset=0; anchor_starts=[]",
    " for index,line in enumerate(lines):",
    "  text=line.decode('utf-8','replace').strip()",
    "  if text and not text.startswith('#'):",
    "   direct=bool(re.match(r'^@[A-Za-z0-9_-]+\\s+path\\s+/g/\\*(?:\\s|$)',text) or re.match(r'^(?:handle|handle_path)\\s+/g/\\*(?:\\s|$)',text))",
    "   block_path=bool(re.match(r'^path\\s+/g/\\*(?:\\s|$)',text))",
    "   if direct: anchor_starts.append(offset)",
    "   elif block_path:",
    "    for previous in range(index-1,-1,-1):",
    "     prior=lines[previous].decode('utf-8','replace').strip()",
    "     if re.match(r'^@[A-Za-z0-9_-]+\\s*\\{\\s*$',prior): anchor_starts.append(sum(len(row) for row in lines[:previous])); break",
    "  offset+=len(line)",
    " candidate_review['insertionAnchorCount']=len(anchor_starts)",
    " assert len(anchor_starts)==1,'refuse to build candidate without one unambiguous /g/* source anchor'",
    " anchor=anchor_starts[0]; candidate_bytes=config_bytes[:anchor]+snippet_bytes+config_bytes[anchor:]",
    " candidate_review['candidateConfigSha256']=hashlib.sha256(candidate_bytes).hexdigest()",
    " candidate_adapt=subprocess.run([sys.argv[1],'adapt','--config','/dev/stdin','--adapter',adapter],input=candidate_bytes,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=12,check=False)",
    " candidate_review['candidateAdaptExitCode']=candidate_adapt.returncode; candidate_doc=None",
    " if candidate_adapt.returncode==0:",
    "  try: candidate_doc=json.loads(candidate_adapt.stdout)",
    "  except Exception: candidate_doc=None",
    " candidate_review['candidateAdaptJsonValid']=candidate_doc is not None",
    " if candidate_doc:",
    "  after_rows=project_routes(candidate_doc); before_rows=route_rows",
    "  selected=[row for row in after_rows if row['paths']==['/g/<ID>','/g/<ID>/*'] and row.get('hosts')==['hyf2333.top'] and row.get('handler')=='reverse_proxy' and row.get('upstreams')==[{'loopback':True,'port':'18454'}] and row.get('hostHeaderSet') is True and row.get('flushInterval')==-1]",
    "  catch_before=[row for row in before_rows if row['paths']==['/g/*'] and row.get('upstreams')==[{'loopback':True,'port':'80'}]]",
    "  catch_after=[row for row in after_rows if row['paths']==['/g/*'] and row.get('upstreams')==[{'loopback':True,'port':'80'}]]",
    "  relay_before=[{k:v for k,v in row.items() if k!='order'} for row in before_rows if any(p.startswith('/_relay/') for p in row['paths'])]",
    "  relay_after=[{k:v for k,v in row.items() if k!='order'} for row in after_rows if any(p.startswith('/_relay/') for p in row['paths'])]",
    "  def semantic(rows): return sorted(json.dumps({k:v for k,v in row.items() if k!='order'},sort_keys=True,separators=(',',':')) for row in rows)",
    "  added=[row for row in after_rows if json.dumps({k:v for k,v in row.items() if k!='order'},sort_keys=True,separators=(',',':')) not in semantic(before_rows)]",
    "  removed=[row for row in before_rows if json.dumps({k:v for k,v in row.items() if k!='order'},sort_keys=True,separators=(',',':')) not in semantic(after_rows)]",
    "  def order_key(value): return tuple(int(part) for part in value.split('.'))",
    "  selected_ok=len(selected)==1 and len(catch_before)==1 and len(catch_after)==1 and order_key(selected[0]['order'])<order_key(catch_after[0]['order'])",
    "  candidate_review['selectedBeforeCatchall']=selected_ok",
    "  candidate_review['selectedOrder']=selected[0]['order'] if len(selected)==1 else None",
    "  candidate_review['catchallBeforeOrder']=catch_before[0]['order'] if len(catch_before)==1 else None",
    "  candidate_review['catchallAfterOrder']=catch_after[0]['order'] if len(catch_after)==1 else None",
    "  candidate_review['relayUnchanged']=semantic(relay_before)==semantic(relay_after)",
    "  candidate_review['catchallUnchanged']=semantic(catch_before)==semantic(catch_after)",
    "  candidate_review['otherRoutesUnchanged']=len(added)==1 and len(removed)==0 and added[0] in selected if added else False",
    "  candidate_review['routeDelta']={'added':added,'removed':removed}",
    "  candidate_review['routeAssertionsPass']=selected_ok and candidate_review['relayUnchanged'] and candidate_review['catchallUnchanged'] and candidate_review['otherRoutesUnchanged']",
    " candidate_review['productionConfigAfterSha256']=hashlib.sha256(open(config,'rb').read()).hexdigest()",
    " candidate_review['productionConfigUnchanged']=candidate_review['productionConfigAfterSha256']==pin['configSha256']",
    " assert candidate_review['productionConfigUnchanged'],'production Caddyfile changed during in-memory dry-run'",
    "def path_list(key):",
    " raw=values.get(key,'')",
    " rows=[]",
    " for token in shlex.split(raw) if raw and raw!='-' else []:",
    "  token=token.lstrip('-'); parts=token.split(':')",
    "  rows.append({'source':parts[0],'destination':parts[1] if len(parts)>1 and parts[1].startswith('/') else parts[0],'readOnly':key=='BindReadOnlyPaths' or (len(parts)>2 and 'ro' in parts[2].split(','))})",
    " return rows",
    "def reload_projection(raw):",
    " path_match=re.search(r'path=([^ ;}]+)',raw or '')",
    " argv_match=re.search(r'argv\\[\\]=([^;}]*)',raw or '')",
    " command=argv_match.group(1).strip() if argv_match else ''",
    " command_tokens=shlex.split(command) if command else []",
    " return {'configured':bool(raw and raw!='-'),'executable':path_match.group(1) if path_match else None,'caddyReload':len(command_tokens)>1 and os.path.basename(command_tokens[0])=='caddy' and command_tokens[1]=='reload','signalsMainPid':'$MAINPID' in (raw or ''),'configPath':arg_value(command_tokens,'--config')}",
    "unit_start=values.get('ExecStart','')",
    "start_path_match=re.search(r'path=([^ ;}]+)',unit_start)",
    "start_argv_match=re.search(r'argv\\[\\]=([^;}]*)',unit_start)",
    "start_tokens=shlex.split(start_argv_match.group(1).strip()) if start_argv_match else []",
    "mounts={'bindPaths':path_list('BindPaths'),'bindReadOnlyPaths':path_list('BindReadOnlyPaths'),'rootDirectory':values.get('RootDirectory') or None,'rootImage':values.get('RootImage') or None,'privateMounts':values.get('PrivateMounts'),'environmentFiles':re.findall(r'path=([^ ;}]+)',values.get('EnvironmentFiles','')),'readWritePaths':shlex.split(values.get('ReadWritePaths','')) if values.get('ReadWritePaths') not in ('','-') else [],'readOnlyPaths':shlex.split(values.get('ReadOnlyPaths','')) if values.get('ReadOnlyPaths') not in ('','-') else []}",
    "result={'service':{'unit':'caddy.service','activeState':values.get('ActiveState'),'subState':values.get('SubState'),'fragmentPath':values.get('FragmentPath'),'user':values.get('User'),'group':values.get('Group'),'execStartPath':start_path_match.group(1) if start_path_match else None,'execStartConfigPath':arg_value(start_tokens,'--config'),'execReload':reload_projection(values.get('ExecReload',''))},'process':{'pid':pid,'euid':euid,'startTicks':start_ticks,'exe':exe,'exeEvidence':'systemd ExecStart path matches /proc argv[0] (same-uid /proc/exe access restricted)','exeSha256':exe_sha,'argvSha256':argv_sha,'argumentFlags':sorted(set(a for a in argv if a.startswith('--') and len(a)<64)),'configPath':config,'adapter':adapter},'config':{'bytes':config_stat.st_size,'sha256':config_hash,'mode':oct(config_stat.st_mode & 0o777),'uid':config_stat.st_uid,'gid':config_stat.st_gid,'linkCount':config_stat.st_nlink,'regularSingleLink':os.path.isfile(config) and config_stat.st_nlink==1,'caddyVersion':version,'adaptExitCode':adapt.returncode,'adaptJsonValid':adapted is not None,'admin':{'disabled':admin_disabled,'listenScope':'loopback-or-disabled' if admin_loopback else 'non-loopback','port':admin_port,'tcpReachable':admin_reachable},'routes':route_rows},'mounts':mounts,'candidateReview':candidate_review,'remoteWrites':False,'serviceChanged':False}",
    "print(json.dumps(result,separators=(',',':')))",
  ].join("\n");
}

function remoteFirewallSnapshotSource() {
  return [
    "import json,os,shutil,subprocess",
    "ports=(443,18453,18454,18455)",
    "def bounded(argv):",
    " try:",
    "  child=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)",
    "  raw=child.stdout.read(262145)",
    "  if len(raw)>262144:",
    "   child.kill(); child.wait(timeout=2); return {'status':'output-limit','exitCode':child.returncode}",
    "  code=child.wait(timeout=5)",
    "  return {'status':'ok' if code==0 else 'permission-or-command-failed','exitCode':code,'raw':raw.decode('utf-8','replace') if code==0 else ''}",
    " except FileNotFoundError: return {'status':'unavailable','exitCode':None,'raw':''}",
    " except Exception: return {'status':'timeout-or-read-error','exitCode':None,'raw':''}",
    "nft_path=shutil.which('nft'); nft=bounded(['sudo','-n',nft_path,'-j','list','ruleset']) if nft_path else {'status':'unavailable','exitCode':None,'raw':''}",
    "policies=[]; nft_rules={str(p):{'matches':0,'verdicts':[]} for p in ports}; parse='unavailable'",
    "def dport_values(obj):",
    " out=[]",
    " if isinstance(obj,dict):",
    "  if 'match' in obj and isinstance(obj['match'],dict):",
    "   cond=obj['match']; left=json.dumps(cond.get('left',{}),separators=(',',':'))",
    "   if 'dport' in left:",
    "    def nums(x):",
    "     if isinstance(x,bool): return []",
    "     if isinstance(x,int) and 0<x<65536: return [x]",
    "     if isinstance(x,list): return sum((nums(v) for v in x),[])",
    "     if isinstance(x,dict): return sum((nums(v) for v in x.values()),[])",
    "     return []",
    "    out.extend(nums(cond.get('right')))",
    "  for value in obj.values(): out.extend(dport_values(value))",
    " elif isinstance(obj,list):",
    "  for value in obj: out.extend(dport_values(value))",
    " return out",
    "def verdicts(obj):",
    " found=set()",
    " if isinstance(obj,dict):",
    "  for key,value in obj.items():",
    "   if key in ('accept','drop','reject') and isinstance(value,dict): found.add(key)",
    "   found.update(verdicts(value))",
    " elif isinstance(obj,list):",
    "  for value in obj: found.update(verdicts(value))",
    " return found",
    "if nft['status']=='ok':",
    " try:",
    "  data=json.loads(nft['raw']); parse='valid-json'; objects=data.get('nftables',[])",
    "  for item in objects:",
    "   chain=item.get('chain') if isinstance(item,dict) else None",
    "   if isinstance(chain,dict) and chain.get('hook')=='input': policies.append({'family':chain.get('family'),'policy':chain.get('policy')})",
    "   rule=item.get('rule') if isinstance(item,dict) else None",
    "   if not isinstance(rule,dict): continue",
    "   expr=rule.get('expr',[]); matches=set(dport_values(expr)); acts=sorted(verdicts(expr))",
    "   for port in ports:",
    "    if port in matches:",
    "     nft_rules[str(port)]['matches']+=1",
    "     nft_rules[str(port)]['verdicts']=sorted(set(nft_rules[str(port)]['verdicts']+acts))",
    " except Exception: parse='invalid-or-unsupported-json'",
    "iptables_path=shutil.which('iptables'); ipt=bounded(['sudo','-n',iptables_path,'-S','INPUT']) if iptables_path else {'status':'unavailable','exitCode':None,'raw':''}",
    "ipt_policy=None; ipt_rules={str(p):{'matches':0,'verdicts':[]} for p in ports}",
    "if ipt['status']=='ok':",
    " for line in ipt['raw'].splitlines():",
    "  fields=line.split()",
    "  if len(fields)>=3 and fields[:2]==['-P','INPUT']: ipt_policy=fields[2]",
    "  if len(fields)<4 or fields[:2]!=['-A','INPUT']: continue",
    "  for port in ports:",
    "   if ('--dport '+str(port)) in line:",
    "    ipt_rules[str(port)]['matches']+=1",
    "    if '-j' in fields:",
    "     target=fields[fields.index('-j')+1].upper(); ipt_rules[str(port)]['verdicts']=sorted(set(ipt_rules[str(port)]['verdicts']+[target if target in ('ACCEPT','DROP','REJECT') else 'OTHER']))",
    "for item in (nft,ipt): item.pop('raw',None)",
    "print(json.dumps({'nft':{'status':nft['status'],'exitCode':nft['exitCode'],'parse':parse,'inputPolicies':policies,'ports':nft_rules},'iptables':{'status':ipt['status'],'exitCode':ipt['exitCode'],'inputPolicy':ipt_policy,'ports':ipt_rules},'scope':'read-only host rules only; cloud ingress policy is not observable here'},separators=(',',':')))",
  ].join("\n");
}

async function runStaticCheck() {
  const relay = await loadPinnedRelayInputs();
  const registrationFetchInputs = await verifyRegistrationFetchInputShapes();
  const pythonScripts = [
    remotePreflightSource(), remoteRootCreateSource(), remotePrivateWriteSource(), remotePrivateUnlinkSource(),
    remoteForwardProbeSource(), remoteLoopbackTlsEntrySource(), remoteCaddyStartSource(), remoteCandidateInspectSource(), remoteCaddyStopSource(),
    remoteRootRemoveSource(), remoteFinalVerifySource(), remoteProductionCaddySnapshotSource(), remoteFirewallSnapshotSource(),
    remoteProductionCaddyInstallSource(), remoteProductionCaddyRestoreSource(), remoteProductionRootProbeSource(), remoteSshIdentityProbeSource(),
  ];
  for (const [index, source] of pythonScripts.entries()) {
    const complete = buildMarkedPythonSource(remoteOwnedProcessGuardSource() + "\n" + source);
    const check = spawnSync("/usr/bin/python3", ["-c", "import sys; compile(sys.stdin.read(), '<owned-remote-candidate>', 'exec')"], {
      input: complete, encoding: "utf8", timeout: 5000, maxBuffer: 1_048_576,
    });
    assert.equal(check.status, 0, "owned remote Python source syntax failed at operation " + index);
    assert.equal(check.error, undefined);
  }
  const rust = await regularFilePin(RUST_BINARY);
  assert.deepEqual(rust, RUST_BINARY_PIN);
  const matchedMobile = await inspectMatchedMobileWebExport(MATCHED_MOBILE_INPUT);
  const mobileSourceSnapshot = await verifyMatchedMobileSourceSnapshot();
  assert.equal(matchedMobile.bundleFiles.length, 37);
  assert.equal(matchedMobile.bundleSha256, MATCHED_MOBILE_INPUT.expectedBundleSha256);
  assert.equal(mobileSourceSnapshot.sourceCommit, MATCHED_MOBILE_SOURCE_SNAPSHOT.sourceCommit);
  const gatewayManifestBytes = await readFile(resolve(GATEWAY_SNAPSHOT, "gateway-runtime-freeze.json"));
  assert.equal(shaBytes(gatewayManifestBytes), GATEWAY_PINS.manifestSha256);
  const gatewayManifest = JSON.parse(gatewayManifestBytes.toString("utf8"));
  assert.equal(gatewayManifest.status, "complete");
  assert.equal(gatewayManifest.sourceTreeSha256, GATEWAY_PINS.sourceTreeSha256);
  assert.equal(gatewayManifest.dependencyTreeSha256, GATEWAY_PINS.dependencyTreeSha256);
  assert.equal(gatewayManifest.sourceFiles.length, GATEWAY_PINS.sourceFileCount);
  assert.equal(gatewayManifest.dependencyFiles.length, GATEWAY_PINS.dependencyFileCount);
  assert.equal(await shaFile(resolve(GATEWAY_SNAPSHOT, "src/mobile-web-static.js")), GATEWAY_PINS.mobileWebStaticSha256);

  const testGatewayId = "1".repeat(32);
  const caddyfile = buildCaddyfile(testGatewayId);
  assert.match(caddyfile, /admin off/);
  assert.match(caddyfile, /auto_https off/);
  assert.ok(caddyfile.includes("tls " + CERT_PATH + " " + KEY_PATH));
  assert.ok(caddyfile.includes("@selectedGateway path /g/" + testGatewayId + " /g/" + testGatewayId + "/*"));
  assert.equal(caddyfile.includes("/g/*"), false);
  assert.equal((caddyfile.match(/reverse_proxy @/g) ?? []).length, 2);
  const productionSnippet = buildProduction443RouteSnippet("a".repeat(24), "b".repeat(32));
  assert.ok(productionSnippet.includes("host " + PUBLIC_DOMAIN));
  assert.ok(productionSnippet.includes("path /g/" + "b".repeat(32) + " /g/" + "b".repeat(32) + "/*"));
  assert.ok(productionSnippet.includes("handle @kcux_mobile_" + "a".repeat(24) + " {"));
  assert.ok(productionSnippet.includes("reverse_proxy 127.0.0.1:" + PROXY_FORWARD_PORT));
  assert.ok(productionSnippet.includes("header_up Host {http.request.hostport}"));
  assert.ok(productionSnippet.includes("flush_interval -1"));
  assert.equal(productionSnippet.includes("/_relay/"), false);
  assert.equal(PRODUCTION_CADDY_PIN.configPath, "/etc/caddy/Caddyfile");
  assert.equal(PRODUCTION_CADDY_PIN.configSha256, PRODUCTION_CADDY_CONFIG_SHA256);
  assert.ok(productionAtomicFsCoreSource().includes("os.O_NOFOLLOW"));
  assert.ok(productionAtomicFsCoreSource().includes("os.fsync(dirfd)"));
  assert.ok(remoteProductionCaddyInstallSource().includes("systemctl','reload','caddy.service"));
  assert.ok(remoteProductionCaddyRestoreSource().includes("current_sha in (candidate_sha,original_sha)"));
  const productionRootCommand = pythonCommand(remoteProductionRootProbeSource(), [], { asRoot: true });
  assert.ok(productionRootCommand.startsWith("sudo -n -- /usr/bin/python3 -c "));
  assert.ok(pythonCommand(remoteSshIdentityProbeSource()).startsWith("python3 -c "));
  assert.equal(classifyReverseForwardReadiness({ tunnelAlive: true,
    proxyForwardReachable: false, controlForwardReachable: false }), "pending");
  assert.equal(classifyReverseForwardReadiness({ tunnelAlive: true,
    proxyForwardReachable: true, controlForwardReachable: false }), "pending");
  assert.equal(classifyReverseForwardReadiness({ tunnelAlive: true,
    proxyForwardReachable: true, controlForwardReachable: true }), "ready");
  assert.equal(classifyReverseForwardReadiness({ tunnelAlive: false,
    proxyForwardReachable: true, controlForwardReachable: true }), "tunnel-exited");
  return {
    state: "STATIC_PASS",
    remoteActions: false,
    gateway: { manifestSha256: GATEWAY_PINS.manifestSha256, sourceTreeSha256: GATEWAY_PINS.sourceTreeSha256,
      dependencyTreeSha256: GATEWAY_PINS.dependencyTreeSha256 },
    mobile: { inputKind: "matched-export-derived-deploy-mount-manifest", comparisonId: MATCHED_MOBILE_INPUT.comparisonId,
      claimBoundary: "matched Git 992 bundle adapted for Gateway mounting; no official Expo receipt or new builder run claimed",
      sourceCommit: mobileSourceSnapshot.sourceCommit, sourceSnapshotManifestSha256: mobileSourceSnapshot.sourceSnapshotManifestSha256,
      sourceSnapshotVerifiedGitBlobs: mobileSourceSnapshot.verifiedGitBlobs, exportManifestSha256: matchedMobile.manifestSha256,
      bundleSha256: matchedMobile.bundleSha256, sourceTreeSha256: matchedMobile.sourceTreeSha256, resources: matchedMobile.bundleFiles.length,
      dependencySourceTreeSha256: matchedMobile.dependency.sourceTreeSha256Before, dependencyOwnedTreeSha256: matchedMobile.dependency.copiedTreeSha256 },
    relay: { baseServerSha256: RELAY_SERVER_BASE_SHA256, patchedServerSha256: relay.patchedServerSha256,
      sourceClosureSha256: relay.sourceClosureSha256, wsVersion: relay.wsVersion,
      wsPackageTreeSha256: relay.wsPackageTreeSha256, patchSha256: relay.patchSha256 },
    registrationFetchInputs,
    productionPrivilegeCommandContract: { sshUserProbe: "python3 -c", rootProbe: "sudo -n -- /usr/bin/python3 -c",
      caddyUserProbe: "sudo -n -u caddy -- python3 -c", restrictedToFixedPythonScripts: true },
    rust: { sourcePath: RUST_BINARY, bytes: rust.bytes, sha256: rust.sha256, configuredOnly: true, rustExecuted: false },
    remotePythonProgramsSyntaxChecked: pythonScripts.length,
    reverseForwardReadinessContract: "both remote loopback probes must succeed while tunnel is live",
    caddyRouteContract: "one selected Gateway path group plus exact Relay paths; admin and auto_https disabled",
    production443RouteDryRunContract: "unique host+Gateway matcher; exact pinned config/process; adapted route precedes unchanged /g/*; no production write or reload",
    production443ApplyContract: "explicit production-only mode; root-owned same-directory backup/stage; exact pinned Caddy reload; verified restore precedes lease cleanup; no remote action in static mode",
  };
}

async function runLocalRustBinaryCopyFixture() {
  await runE2E(import.meta.url, { testId: "mobile-gateway-rust-binary-owned-copy-contract", tier: "local-contract",
    retainSuccessLogs: true, cleanupTimeoutMs: 15_000, modelPolicy: "pinned build03 binary copied exclusively into owned state; no execution or shared binary write" }, async context => {
    const copied = await copyPinnedRustBinary(context);
    const info = await lstat(copied.path);
    assert.equal(info.isFile(), true); assert.equal(info.isSymbolicLink(), false); assert.equal(info.mode & 0o777, 0o700);
    const evidence = { sourcePath: RUST_BINARY, bytes: copied.bytes, sha256: copied.sha256, exclusiveCreate: true, fsync: true, sourceStableBeforeAfter: true, binaryExecuted: false, sharedBinaryChanged: false };
    await context.writeArtifactJson("owned-rust-binary-copy.json", evidence);
    return evidence;
  });
}

async function runLocalRegistrationPreflight() {
  await runE2E(import.meta.url, {
    testId: "mobile-gateway-isolated-public-tls-local-registration-preflight",
    tier: "manual-live",
    retainSuccessLogs: true,
    bodyAbortTimeoutMs: 10_000,
    cleanupTimeoutMs: 30_000,
    modelPolicy: "local owned Relay registration-observer verification only; no SSH, public network, Caddy, Gateway, Chromium, or Provider call",
  }, async context => {
    const evidence = {
      state: "running", stage: "pinned-local-relay-inputs",
      authority: "RunContext result.json and manifest.json",
      publicOperations: false, sshStarted: false, browserStarted: false,
      registrationFetchInputKinds: 3,
      relay: { sourceClosureSha256: null, patchedServerSha256: null, wsPackageTreeSha256: null,
        controlPortOwned: false, proxyPortOwned: false, registrationPostCount: 0,
        registrationStatus: null, controlOnline: false, identityFilePrivate: false, identityFingerprint: null },
      cleanup: { localRelayClientClosed: false, localRelayClosed: false },
    };
    context.addCleanup("write safe local registration preflight evidence", async () => {
      if (evidence.state === "running") evidence.state = "incomplete";
      await context.writeArtifactJsonInternal("local-registration-preflight.json", evidence);
    });
    const relayInputs = await loadPinnedRelayInputs();
    evidence.relay.sourceClosureSha256 = relayInputs.sourceClosureSha256;
    evidence.relay.patchedServerSha256 = relayInputs.patchedServerSha256;
    evidence.relay.wsPackageTreeSha256 = relayInputs.wsPackageTreeSha256;
    await verifyRegistrationFetchInputShapes();

    const runtimeRoot = context.pathInState("relay-runtime");
    await materializePinnedRelayRuntime(context, runtimeRoot, relayInputs.files, relayInputs.patchedServer);
    const relayModule = await import(pathToFileURL(join(runtimeRoot, "apps/kcoder-relay/src/server.mjs")).href);
    const clientModule = await import(pathToFileURL(join(runtimeRoot, "apps/kcoder-relay/src/client.mjs")).href);
    const registrationKey = randomBytes(32).toString("hex");
    const pairingToken = randomBytes(32).toString("hex");
    context.registerSecret(registrationKey);
    context.registerSecret(pairingToken);
    const registrationStoreFile = context.pathInState("relay/registration-store.json");
    await mkdir(dirname(registrationStoreFile), { recursive: true, mode: 0o700 });
    const relay = await relayModule.startRelay({ gateways: [], sharedHosts: ["127.0.0.1"], registrationKey,
      registrationStoreFile, controlPort: 0, proxyPort: 0 });
    context.registerPort("local preflight Relay control", relay.controlPort);
    context.registerPort("local preflight Relay proxy", relay.proxyPort);
    evidence.relay.controlPortOwned = true;
    evidence.relay.proxyPortOwned = true;
    context.addCleanup("close local preflight Relay", async () => {
      await relay.close();
      evidence.cleanup.localRelayClosed = true;
    });

    let controlOnline = false;
    const identityFile = context.pathInState("relay/client-identity.json");
    const observer = createRegistrationFetchObserver({
      expectedOrigin: "http://127.0.0.1:" + relay.controlPort,
      onForward: count => { evidence.relay.registrationPostCount = count; },
      onResponse: status => { evidence.relay.registrationStatus = status; },
    });
    const client = await clientModule.startRegisteredClient({
      url: "http://127.0.0.1:" + relay.controlPort,
      registrationKey, pairingToken, identityFile,
      gateway: "http://127.0.0.1:9", allowInsecure: true, retryMs: 100,
      onOnline: () => { controlOnline = true; },
      fetchImpl: observer.fetchImpl,
    });
    context.addCleanup("close local preflight Relay client", () => {
      client.close();
      evidence.cleanup.localRelayClientClosed = true;
    });
    await waitFor(() => controlOnline, 15_000, "local Relay control channel online", 25, context.abortSignal);
    evidence.relay.controlOnline = true;
    assert.equal(observer.forwardCount, 1, "one local registration POST is observed");
    assert.equal(observer.responseStatus, 201, "local Relay accepts the registration");
    assert.equal(evidence.relay.registrationPostCount, 1);
    assert.equal(evidence.relay.registrationStatus, 201);
    const identityStat = await lstat(identityFile);
    assert.ok(identityStat.isFile() && !identityStat.isSymbolicLink());
    assert.equal(identityStat.mode & 0o777, 0o600);
    const identity = JSON.parse(await readFile(identityFile, "utf8"));
    assert.match(identity.id, /^[a-f0-9]{32}$/);
    assert.match(identity.secret, /^[A-Za-z0-9_-]{43,}$/);
    context.registerSecret(identity.id);
    context.registerSecret(identity.secret);
    evidence.relay.identityFilePrivate = true;
    evidence.relay.identityFingerprint = shaBytes(Buffer.from(identity.id)).slice(0, 16);
    evidence.stage = "local-registration-and-control-online-passed";
    evidence.state = "PASS";
    return {
      state: evidence.state,
      registrationPostCount: evidence.relay.registrationPostCount,
      registrationStatus: evidence.relay.registrationStatus,
      controlOnline: evidence.relay.controlOnline,
      identityFingerprint: evidence.relay.identityFingerprint,
      sourceClosureSha256: evidence.relay.sourceClosureSha256,
    };
  });
}

async function runReadonlyCaddyVersionProbe() {
  await runE2E(import.meta.url, {
    testId: "mobile-gateway-isolated-public-tls-caddy-version-readonly",
    tier: "manual-live",
    retainSuccessLogs: true,
    bodyAbortTimeoutMs: 10_000,
    cleanupTimeoutMs: 30_000,
    modelPolicy: "one read-only Caddy version query over the owned SSH harness; no files, services, ports, or production configuration are changed",
  }, async context => {
    const sshConfig = requireAbsolute("KCODER_E2E_PUBLIC_SSH_CONFIG");
    const sshKnownHosts = requireAbsolute("KCODER_E2E_PUBLIC_SSH_KNOWN_HOSTS");
    await Promise.all([sshConfig, sshKnownHosts].map(assertRegularNoSymlink));
    const target = process.env.KCODER_E2E_PUBLIC_SSH_TARGET || "aliyun";
    assert.match(target, /^[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?$/);
    const directOptions = [
      "-F", sshConfig, "-o", "UserKnownHostsFile=" + sshKnownHosts,
      "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes",
      "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=15",
    ];
    const managedSsh = await startOwnedSshControlMaster(context, {
      binary: SSH_BIN, target, configPath: sshConfig, knownHostsPath: sshKnownHosts, cwd: repoRoot,
    });
    const dispatcher = createOwnedSshDispatcher({
      primaryContext: context, managedTransport: managedSsh, binary: SSH_BIN, target, directOptions,
    });
    const result = await runOwnedSshOperation({
      context, dispatcher, label: "caddy-version-readonly",
      command: "sudo -n -u caddy -- /usr/bin/caddy version", cwd: repoRoot,
      timeoutMs: 15_000, maxStdoutBytes: 512, maxStderrBytes: 2048,
    });
    const output = result.stdout.toString("utf8").trim();
    assert.ok(output.length > 0 && Buffer.byteLength(output) <= 256);
    const version = output.split(/\s+/, 1)[0];
    assert.match(version, /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}$/);
    const evidence = {
      state: "PASS", command: "caddy version as the existing caddy service user",
      version, stderrBytes: result.stderrBytes,
      remoteWrite: false, serviceRestart: false, productionConfigChanged: false,
    };
    await context.writeArtifactJson("caddy-version-readonly.json", evidence);
    return evidence;
  });
}

async function runLocalCaddyRollbackFixturePreflight() {
  await runE2E(import.meta.url, {
    testId: "mobile-gateway-production-caddy-atomic-rollback-local-fixture",
    tier: "local-contract",
    retainSuccessLogs: true,
    cleanupTimeoutMs: 10_000,
    modelPolicy: "local same-owner synthetic Caddyfile atomic replace and restore contract; no SSH, network, service, or production file access",
  }, async context => {
    const snippet = buildProduction443RouteSnippet("a".repeat(24), "b".repeat(32));
    const fixture = await runSyntheticCaddyAtomicRollbackFixture(context, snippet);
    const evidence = { ...fixture, remoteActions: false, productionConfigChanged: false, serviceReloaded: false };
    await context.writeArtifactJson("production-caddy-atomic-rollback-local-fixture.json", evidence);
    return evidence;
  });
}

async function runLocalProductionCaddyRollbackPreflight() {
  await runE2E(import.meta.url, {
    testId: "mobile-gateway-production-caddy-rollback-source-contract",
    tier: "local-contract",
    retainSuccessLogs: true,
    cleanupTimeoutMs: 10_000,
    modelPolicy: "same-owner synthetic filesystem test of the production transaction primitives; no SSH, /etc access, Caddy service, public network, or production permission claim",
  }, async context => {
    const fixtureRoot = context.pathInState("production-caddy-transaction-contract");
    const python = [
      "import hashlib,json,os,stat,sys",
      productionAtomicFsCoreSource(),
      productionCandidateStageSource(),
      "root=sys.argv[1]; os.mkdir(root,0o700); uid=os.getuid(); gid=os.getgid(); mode=0o644",
      "def seed(name,original,candidate,backup=None):\n directory=os.path.join(root,name); os.mkdir(directory,0o700); config=os.path.join(directory,'Caddyfile'); backup_path=os.path.join(directory,'backup'); fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)\n try:\n  _write_owned_exclusive(fd,'Caddyfile',original,uid,gid,mode); _write_owned_exclusive(fd,'backup',original if backup is None else backup,uid,gid,0o600); _write_owned_exclusive(fd,'candidate-stage',candidate,uid,gid,mode); _atomic_replace(fd,'candidate-stage','Caddyfile'); os.fsync(fd)\n finally: os.close(fd)\n return config,backup_path",
      "original=b'synthetic-original\\n'; candidate=b'synthetic-candidate\\n'; uid=os.getuid(); gid=os.getgid()",
      "config,backup=seed('success',original,candidate)",
      "_restore_owned_config(config,backup,'restore-stage',hashlib.sha256(candidate).hexdigest(),hashlib.sha256(original).hexdigest(),uid,gid,mode)",
      "restored,meta=_read_owned_file(config,uid,gid,mode); assert restored==original",
      "third=b'synthetic-third-party-change\\n'; real_write=_write_owned_exclusive\ndef race_writer(config_path,trigger):\n def hooked(fd,leaf,data,uid,gid,file_mode,fail_after=None):\n  result=real_write(fd,leaf,data,uid,gid,file_mode,fail_after)\n  if leaf==trigger:\n   dfd=os.open(os.path.dirname(config_path),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)\n   try: real_write(dfd,'third-party-stage',third,uid,gid,file_mode); os.replace('third-party-stage',os.path.basename(config_path),src_dir_fd=dfd,dst_dir_fd=dfd); os.fsync(dfd)\n   finally: os.close(dfd)\n  return result\n return hooked",
      "race_config,race_backup=seed('restore-stage-race',original,candidate); _write_owned_exclusive=race_writer(race_config,'restore-stage')\ntry: _restore_owned_config(race_config,race_backup,'restore-stage',hashlib.sha256(candidate).hexdigest(),hashlib.sha256(original).hexdigest(),uid,gid,mode); raise AssertionError('restore race accepted')\nexcept AssertionError as e: assert str(e)!='restore race accepted'\nfinally: _write_owned_exclusive=real_write",
      "race_live,_=_read_owned_file(race_config,uid,gid,mode); race_bak,_=_read_owned_file(race_backup,uid,gid,0o600); race_stage,_=_read_owned_file(os.path.join(os.path.dirname(race_config),'restore-stage'),uid,gid,mode); assert race_live==third and race_bak==original and race_stage==original",
      "install_dir=os.path.join(root,'install-stage-race'); os.mkdir(install_dir,0o700); install_config=os.path.join(install_dir,'Caddyfile'); install_fd=os.open(install_dir,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); _write_owned_exclusive(install_fd,'Caddyfile',original,uid,gid,mode); _,install_meta=_read_owned_file(install_config,uid,gid,mode); _write_owned_exclusive=real_write",
      "_write_owned_exclusive=race_writer(install_config,'candidate-stage')\ntry:\n _prepare_candidate_files(install_dir,install_fd,'backup','candidate-stage',original,candidate,hashlib.sha256(original).hexdigest(),hashlib.sha256(candidate).hexdigest(),uid,gid)\n try: _commit_staged_config(install_fd,install_dir,'candidate-stage','Caddyfile',hashlib.sha256(candidate).hexdigest(),hashlib.sha256(original).hexdigest(),install_meta,uid,gid,mode); raise AssertionError('install race accepted')\n except AssertionError as e: assert str(e)!='install race accepted'\nfinally: _write_owned_exclusive=real_write; os.close(install_fd)",
      "install_live,_=_read_owned_file(install_config,uid,gid,mode); install_bak,_=_read_owned_file(os.path.join(install_dir,'backup'),uid,gid,0o600); install_stage,_=_read_owned_file(os.path.join(install_dir,'candidate-stage'),uid,gid,mode); assert install_live==third and install_bak==original and install_stage==candidate",
      "drift_config,drift_backup=seed('drift',original,candidate)\nwith open(drift_config,'wb') as f: f.write(b'foreign-change\\n'); f.flush(); os.fsync(f.fileno())\ntry: _restore_owned_config(drift_config,drift_backup,'restore-stage',hashlib.sha256(candidate).hexdigest(),hashlib.sha256(original).hexdigest(),uid,gid,mode); raise AssertionError('drift accepted')\nexcept AssertionError as e: assert str(e)!='drift accepted'\ndrift_after,_=_read_owned_file(drift_config,uid,gid,mode); assert drift_after==b'foreign-change\\n'",
      "bad_config,bad_backup=seed('bad-backup',original,candidate,b'wrong-backup\\n')\ntry: _restore_owned_config(bad_config,bad_backup,'restore-stage',hashlib.sha256(candidate).hexdigest(),hashlib.sha256(original).hexdigest(),uid,gid,mode); raise AssertionError('bad backup accepted')\nexcept AssertionError as e: assert str(e)!='bad backup accepted'\nbad_after,_=_read_owned_file(bad_config,uid,gid,mode); assert bad_after==candidate",
      "link_dir=os.path.join(root,'symlink'); os.mkdir(link_dir,0o700); target=os.path.join(link_dir,'target'); open(target,'wb').write(candidate); os.chmod(target,mode); link_config=os.path.join(link_dir,'Caddyfile'); os.symlink(target,link_config)\ntry: _restore_owned_config(link_config,bad_backup,'restore-stage',hashlib.sha256(candidate).hexdigest(),hashlib.sha256(original).hexdigest(),uid,gid,mode); raise AssertionError('symlink accepted')\nexcept (AssertionError,OSError) as e: assert str(e)!='symlink accepted'",
      "backup_fail_dir=os.path.join(root,'backup-write-failure'); os.mkdir(backup_fail_dir,0o700); backup_fd=os.open(backup_fail_dir,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)\ntry:\n _write_owned_exclusive(backup_fd,'Caddyfile',original,uid,gid,mode)\n try: _prepare_candidate_files(backup_fail_dir,backup_fd,'backup','candidate.stage',original,candidate,hashlib.sha256(original).hexdigest(),hashlib.sha256(candidate).hexdigest(),uid,gid,'backup'); raise AssertionError('partial backup write accepted')\n except OSError as e: assert str(e)!='partial backup write accepted'\n assert not os.path.lexists(os.path.join(backup_fail_dir,'backup')) and not os.path.lexists(os.path.join(backup_fail_dir,'candidate.stage'))\n backup_fail_config,_=_read_owned_file(os.path.join(backup_fail_dir,'Caddyfile'),uid,gid,mode); assert backup_fail_config==original\nfinally: os.close(backup_fd)",
      "stage_fail_dir=os.path.join(root,'candidate-stage-write-failure'); os.mkdir(stage_fail_dir,0o700); stage_config=os.path.join(stage_fail_dir,'Caddyfile'); stage_fd=os.open(stage_fail_dir,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)\ntry:\n _write_owned_exclusive(stage_fd,'Caddyfile',original,uid,gid,mode)\n try: _prepare_candidate_files(stage_fail_dir,stage_fd,'backup','candidate.stage',original,candidate,hashlib.sha256(original).hexdigest(),hashlib.sha256(candidate).hexdigest(),uid,gid,'candidate.stage'); raise AssertionError('partial candidate stage write accepted')\n except OSError as e: assert str(e)!='partial candidate stage write accepted'\n assert not os.path.lexists(os.path.join(stage_fail_dir,'candidate.stage'))\n stage_live,_=_read_owned_file(stage_config,uid,gid,mode); assert stage_live==original\n stage_backup,_=_read_owned_file(os.path.join(stage_fail_dir,'backup'),uid,gid,0o600); assert stage_backup==original\nfinally: os.close(stage_fd)",
      "print(json.dumps({'state':'PASS','atomicRestore':True,'restoreRaceRefused':True,'installRaceRefused':True,'thirdPartyConfigPreserved':True,'backupAndStageRetained':True,'driftRefused':True,'badBackupRefused':True,'symlinkRefused':True,'backupWriteFailureCleaned':True,'candidateStageWriteFailureCleaned':True,'sameOwnerFixture':True,'productionConfigTouched':False,'etcPermissionsProven':False},separators=(',',':'))) ",
    ].join("\n");
    const stdout = execFileSync("/usr/bin/python3", ["-c", python, fixtureRoot], { encoding: "utf8", timeout: 15_000, maxBuffer: 4096 });
    const result = JSON.parse(stdout);
    const rootProbeCommand = pythonCommand(remoteProductionRootProbeSource(), [], { asRoot: true });
    assert.ok(rootProbeCommand.startsWith("sudo -n -- /usr/bin/python3 -c "));
    assert.ok(pythonCommand("pass", [], { asCaddy: true }).startsWith("sudo -n -u caddy -- python3 -c "));
    assert.ok(pythonCommand("pass").startsWith("python3 -c "));
    assert.throws(() => pythonCommand("pass", [], { asRoot: true, asCaddy: true }));
    assert.deepEqual(result, { state: "PASS", atomicRestore: true, restoreRaceRefused: true, installRaceRefused: true,
      thirdPartyConfigPreserved: true, backupAndStageRetained: true, driftRefused: true, badBackupRefused: true,
      symlinkRefused: true, backupWriteFailureCleaned: true, candidateStageWriteFailureCleaned: true,
      sameOwnerFixture: true, productionConfigTouched: false, etcPermissionsProven: false });
    const recoveryFixtureRoot = context.pathInState("production-caddy-recovery-cli-contract");
    const runRoot = join(recoveryFixtureRoot, "20261009-223000.000Z");
    const runId = "a".repeat(24);
    const recoveryRequired = {
      state: "RECOVERY_REQUIRED", runRoot, runId, originalConfigSha256: PRODUCTION_CADDY_PIN.configSha256,
      candidateConfigSha256: "b".repeat(64), forwardAndRelayRetained: true,
      exactRecoveryCommand: productionRecoveryCommand(runRoot),
    };
    const transaction = {
      version: 1, mode: "production-caddy-443-selected-gateway-route", runId,
      configPath: PRODUCTION_CADDY_PIN.configPath, pin: PRODUCTION_CADDY_PIN,
      originalConfigSha256: PRODUCTION_CADDY_PIN.configSha256, candidateConfigSha256: "b".repeat(64),
      backupLeaf: ".Caddyfile.kcux-" + runId + ".backup", routeSnippetSha256: "c".repeat(64),
      selectedGatewayFingerprint: "d".repeat(16),
    };
    const manifest = { source: PRODUCTION_RUNNER_SOURCE, testId: "mobile-gateway-isolated-public-tls-once", status: "failed" };
    const ownerFence = await currentProcessFence();
    const intent = { version: 1, state: "READY_FOR_APPLY", runRoot, runId, ownerFence, transaction,
      exactRecoveryCommand: recoveryRequired.exactRecoveryCommand };
    const expectedRecoveryCommand = productionRecoveryCommand(runRoot);
    assert.equal(ownerFence.exePath, await realpath(EXPECTED_NODE));
    assert.equal(await inspectProcessFence(ownerFence), "alive");
    const recoveryPlan = validateProductionRecoveryPlan({ runRoot, manifest, recoveryRequired, transaction, intent,
      ownerState: "alive", source: PRODUCTION_RUNNER_SOURCE, testId: manifest.testId,
      expectedPin: PRODUCTION_CADDY_PIN, expectedExecutable: ownerFence.exePath, expectedRecoveryCommand });
    assert.deepEqual(recoveryPlan, { runId, candidateConfigSha256: "b".repeat(64), ownerState: "alive" });
    assert.ok(recoveryRequired.exactRecoveryCommand.includes(resolve(repoRoot, PRODUCTION_RUNNER_SOURCE)));
    assert.ok(recoveryRequired.exactRecoveryCommand.includes("--recover-production-caddy-443") && recoveryRequired.exactRecoveryCommand.endsWith(shellQuote(runRoot)));
    assert.equal(typeof runProductionCaddyRecovery, "function");
    assert.throws(() => validateProductionRecoveryPlan({ runRoot, manifest,
      recoveryRequired: { ...recoveryRequired, forwardAndRelayRetained: false }, transaction, intent,
      ownerState: "alive", source: PRODUCTION_RUNNER_SOURCE, testId: manifest.testId,
      expectedPin: PRODUCTION_CADDY_PIN, expectedExecutable: ownerFence.exePath, expectedRecoveryCommand }));
    assert.throws(() => validateProductionRecoveryPlan({ runRoot, manifest,
      recoveryRequired: { ...recoveryRequired, candidateConfigSha256: "e".repeat(64) }, transaction, intent,
      ownerState: "alive", source: PRODUCTION_RUNNER_SOURCE, testId: manifest.testId,
      expectedPin: PRODUCTION_CADDY_PIN, expectedExecutable: ownerFence.exePath, expectedRecoveryCommand }));
    assert.throws(() => validateProductionRecoveryPlan({ runRoot, manifest: { ...manifest, status: "running" },
      recoveryRequired: null, transaction, intent, ownerState: "alive", source: PRODUCTION_RUNNER_SOURCE,
      testId: manifest.testId, expectedPin: PRODUCTION_CADDY_PIN, expectedExecutable: ownerFence.exePath,
      expectedRecoveryCommand }));
    assert.equal(await inspectProcessFence({ ...ownerFence, startTicks: "0" }), "pid-reused");
    assert.equal(await inspectProcessFence({ ...ownerFence, argvSha256: "f".repeat(64) }), "identity-mismatch");

    const interruptedRoot = context.pathInState("interrupted-recovery-fixture");
    const interruptedArtifacts = join(interruptedRoot, "artifacts");
    await mkdir(interruptedArtifacts, { recursive: true, mode: 0o700 });
    const interruptedRunId = "e".repeat(24);
    const interruptedTransaction = { ...transaction, runId: interruptedRunId,
      backupLeaf: ".Caddyfile.kcux-" + interruptedRunId + ".backup" };
    const absentOwner = { pid: 2_147_483_647, startTicks: "1", exePath: ownerFence.exePath, argvSha256: "0".repeat(64) };
    const interruptedManifest = { ...manifest, status: "running" };
    const interruptedIntent = { version: 1, state: "READY_FOR_APPLY", runRoot: interruptedRoot,
      runId: interruptedRunId, ownerFence: absentOwner, transaction: interruptedTransaction,
      exactRecoveryCommand: productionRecoveryCommand(interruptedRoot) };
    await writeFixtureJson(join(interruptedRoot, "manifest.json"), interruptedManifest);
    await writeFixtureJson(join(interruptedArtifacts, "production-caddy-443-transaction.json"), interruptedTransaction);
    const fixtureContext = { writeArtifactJsonInternal: async (name, value) => {
      assert.equal(name, "production-caddy-443-recovery-intent.json");
      const path = join(interruptedArtifacts, name); await writeFixtureJson(path, value); return path;
    } };
    await writeDurableRecoveryIntent(fixtureContext, interruptedIntent);
    const loadedManifest = await readPrivateRunJson(join(interruptedRoot, "manifest.json"));
    const loadedTransaction = await readPrivateRunJson(join(interruptedArtifacts, "production-caddy-443-transaction.json"));
    const loadedIntent = await readPrivateRunJson(join(interruptedArtifacts, "production-caddy-443-recovery-intent.json"));
    const interruptedOwnerState = await inspectProcessFence(loadedIntent.ownerFence);
    assert.equal(interruptedOwnerState, "dead");
    const interruptedPlan = validateProductionRecoveryPlan({ runRoot: interruptedRoot, manifest: loadedManifest,
      recoveryRequired: null, transaction: loadedTransaction, intent: loadedIntent, ownerState: interruptedOwnerState,
      source: PRODUCTION_RUNNER_SOURCE, testId: manifest.testId, expectedPin: PRODUCTION_CADDY_PIN,
      expectedExecutable: ownerFence.exePath, expectedRecoveryCommand: loadedIntent.exactRecoveryCommand });
    assert.equal(interruptedPlan.ownerState, "dead");
    const cleaningPlan = validateProductionRecoveryPlan({ runRoot: interruptedRoot,
      manifest: { ...loadedManifest, status: "cleaning" }, recoveryRequired: null,
      transaction: loadedTransaction, intent: loadedIntent, ownerState: interruptedOwnerState,
      source: PRODUCTION_RUNNER_SOURCE, testId: manifest.testId, expectedPin: PRODUCTION_CADDY_PIN,
      expectedExecutable: ownerFence.exePath, expectedRecoveryCommand: loadedIntent.exactRecoveryCommand });
    assert.equal(cleaningPlan.ownerState, "dead");
    const evidence = { ...result, recoveryCliPlanValidation: true, recoveryCliEntryBound: true,
      recoveryPlanRejectsMismatchedLeaseAndCandidate: true, interruptedManifestRecoveryPlanValidated: true,
      interruptedCleaningManifestRecoveryPlanValidated: true,
      prewrittenRecoveryIntentDurable: true, deadOwnerProvenByPidAndStartTicks: true,
      pidReuseAndIdentityMismatchRejected: true, liveOwnerWithoutFailureReceiptRefused: true,
      rootInvocationContract: { production: "sudo -n -- /usr/bin/python3 -c", caddy: "sudo -n -u caddy -- python3 -c",
        ordinary: "python3 -c", unrestrictedSudo: false },
      remoteActions: false };
    await context.writeArtifactJson("production-caddy-transaction-local-contract.json", evidence);
    return evidence;
  });
}

async function runReadonlyProductionCaddyReview({ routeDryRun = false } = {}) {
  await runE2E(import.meta.url, {
    testId: routeDryRun ? "mobile-gateway-production-443-route-dry-run" : "mobile-gateway-production-443-route-readonly-review",
    tier: "manual-live",
    retainSuccessLogs: true,
    bodyAbortTimeoutMs: 20_000,
    cleanupTimeoutMs: 30_000,
    modelPolicy: "read-only Caddy/process/firewall projection and exact admin plus bounded sudo identity probes; no config, service, firewall, port, or production data changes",
  }, async context => {
    const sshConfig = requireAbsolute("KCODER_E2E_PUBLIC_SSH_CONFIG");
    const sshKnownHosts = requireAbsolute("KCODER_E2E_PUBLIC_SSH_KNOWN_HOSTS");
    await Promise.all([sshConfig, sshKnownHosts].map(assertRegularNoSymlink));
    const target = process.env.KCODER_E2E_PUBLIC_SSH_TARGET || "aliyun";
    assert.match(target, /^[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?$/);
    const directOptions = [
      "-F", sshConfig, "-o", "UserKnownHostsFile=" + sshKnownHosts,
      "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes",
      "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=15",
    ];
    const managedSsh = await startOwnedSshControlMaster(context, {
      binary: SSH_BIN, target, configPath: sshConfig, knownHostsPath: sshKnownHosts, cwd: repoRoot,
    });
    const dispatcher = createOwnedSshDispatcher({
      primaryContext: context, managedTransport: managedSsh, binary: SSH_BIN, target, directOptions,
    });
    const runId = shaBytes(Buffer.from("production-443-route-dry-run:" + context.seed)).slice(0, 24);
    const syntheticGatewayId = shaBytes(Buffer.from("production-443-synthetic-gateway:" + context.seed)).slice(0, 32);
    const snippet = routeDryRun ? buildProduction443RouteSnippet(runId, syntheticGatewayId) : null;
    const rollbackFixture = routeDryRun ? await runSyntheticCaddyAtomicRollbackFixture(context, snippet) : null;
    const caddyArguments = routeDryRun
      ? [CADDY_BIN, JSON.stringify(PRODUCTION_CADDY_PIN), runId, syntheticGatewayId, snippet]
      : [CADDY_BIN];
    const rootProbe = runOwnedSshOperation({ context, dispatcher, label: "production-caddy-root-invocation-readonly",
      command: pythonCommand(remoteProductionRootProbeSource(), [], { asRoot: true }),
      cwd: repoRoot, timeoutMs: 10_000, maxStdoutBytes: 512, maxStderrBytes: 2048 })
      .then(result => ({ stdout: result.stdout.toString("utf8") }))
      .catch(error => ({ errorClass: safeFailureClass(error) }));
    const adminProbe = runOwnedSshOperation({ context, dispatcher, label: "production-caddy-ssh-account-readonly",
      command: pythonCommand(remoteSshIdentityProbeSource()), cwd: repoRoot,
      timeoutMs: 10_000, maxStdoutBytes: 512, maxStderrBytes: 2048 })
      .then(result => ({ stdout: result.stdout.toString("utf8") }))
      .catch(error => ({ errorClass: safeFailureClass(error) }));
    const [caddyResult, firewallResult, rootResult, adminResult] = await Promise.all([
      runOwnedSshOperation({
        context, dispatcher, label: "production-caddy-safe-projection",
        command: pythonCommand(remoteProductionCaddySnapshotSource(), caddyArguments, { asCaddy: true }),
        cwd: repoRoot, timeoutMs: 20_000, maxStdoutBytes: 32_768, maxStderrBytes: 2048,
      }),
      runOwnedSshOperation({
        context, dispatcher, label: "host-firewall-safe-projection",
        command: pythonCommand(remoteFirewallSnapshotSource()),
        cwd: repoRoot, timeoutMs: 10_000, maxStdoutBytes: 16_384, maxStderrBytes: 2048,
      }),
      rootProbe,
      adminProbe,
    ]);
    const caddy = parseRemoteObject(caddyResult.stdout.toString("utf8"));
    const firewall = parseRemoteObject(firewallResult.stdout.toString("utf8"));
    const rootPrivilege = rootResult.errorClass ? { available: false, errorClass: rootResult.errorClass }
      : { available: true, ...parseRemoteObject(rootResult.stdout) };
    const remoteAccount = adminResult.errorClass ? { available: false, errorClass: adminResult.errorClass }
      : { available: true, ...parseRemoteObject(adminResult.stdout) };
    if (rootPrivilege.available) assert.deepEqual(rootPrivilege, { available: true, euid: 0 });
    if (remoteAccount.available) {
      assert.deepEqual(Object.keys(remoteAccount).sort(), ["available", "euid", "user"]);
      assert.equal(remoteAccount.user, "admin");
      assert.notEqual(remoteAccount.euid, 0);
    }
    assert.equal(caddy.remoteWrites, false);
    assert.equal(caddy.serviceChanged, false);
    const candidate = routeDryRun ? {
      routeSnippet: snippet,
      snippetSha256: shaBytes(Buffer.from(snippet)),
      runId,
      syntheticGatewayId,
      syntheticIdRegistered: false,
      configChanged: false,
      reloadIssued: false,
      review: caddy.candidateReview,
      sameOwnerAtomicRollbackFixture: rollbackFixture,
    } : null;
    const evidence = {
      state: routeDryRun ? "READONLY_DRY_RUN" : "READONLY_COMPLETE",
      authority: "RunContext result.json and manifest.json",
      caddy,
      firewall,
      remoteAccount,
      rootPrivilege,
      productionApplyPrivilegeReady: remoteAccount.available && remoteAccount.user === "admin"
        && remoteAccount.euid !== 0 && rootPrivilege.available && rootPrivilege.euid === 0,
      candidate,
      noConfigOrLogContentsPersisted: true,
      noProductionMutation: true,
    };
    await context.writeArtifactJson(routeDryRun ? "production-caddy-443-route-dry-run.json" : "production-caddy-443-readonly-review.json", evidence);
    if (routeDryRun) {
      assert.equal(caddy.candidateReview?.requested, true);
      assert.equal(caddy.candidateReview?.candidateAdaptJsonValid, true);
      assert.equal(caddy.candidateReview?.routeAssertionsPass, true);
      assert.equal(caddy.candidateReview?.selectedBeforeCatchall, true);
      assert.equal(caddy.candidateReview?.relayUnchanged, true);
      assert.equal(caddy.candidateReview?.catchallUnchanged, true);
      assert.equal(caddy.candidateReview?.otherRoutesUnchanged, true);
      assert.equal(caddy.candidateReview?.insertionAnchorCount, 1);
      assert.equal(caddy.process.configPath, PRODUCTION_CADDY_CONFIG);
      assert.equal(caddy.config.sha256, PRODUCTION_CADDY_CONFIG_SHA256);
    }
    return {
      state: routeDryRun ? "READONLY_DRY_RUN_PASS" : evidence.state,
      caddyVersion: caddy.config.caddyVersion,
      configPath: caddy.process.configPath,
      configSha256: caddy.config.sha256,
      adaptJsonValid: caddy.config.adaptJsonValid,
      selectedGatewayRoutes: caddy.config.routes.filter(row => row.paths.some(path => path.startsWith("/g/"))).length,
      relayRoutes: caddy.config.routes.filter(row => row.paths.some(path => path.startsWith("/_relay/"))).length,
      adminDisabled: caddy.config.admin.disabled,
      execReloadConfigured: caddy.service.execReload.configured,
      firewallNftStatus: firewall.nft.status,
      firewallIptablesStatus: firewall.iptables.status,
      remoteSshUser: remoteAccount.available ? remoteAccount.user : null,
      remoteSshEuid: remoteAccount.available ? remoteAccount.euid : null,
      sudoNonInteractiveAvailable: rootPrivilege.available,
      productionApplyPrivilegeReady: remoteAccount.available && remoteAccount.user === "admin"
        && remoteAccount.euid !== 0 && rootPrivilege.available && rootPrivilege.euid === 0,
      candidateConfigSha256: caddy.candidateReview?.candidateConfigSha256 ?? null,
      candidateRouteDelta: caddy.candidateReview?.routeDelta ?? null,
      candidateSelectedBeforeCatchall: caddy.candidateReview?.selectedBeforeCatchall ?? null,
      noProductionMutation: true,
    };
  });
}
const WS_PIN = Object.freeze({
  version: "8.22.0",
  packageTreeSha256: "3271cba667fdc4721ed9fe275eae78247d07ded06cddd52b824359880aeb4c1d",
});
const GATEWAY_SNAPSHOT = resolve(repoRoot, "target/private-phone-ux-implementation/shared-gateway-current-20261009/snapshot-20261009-223221.326Z");
const GATEWAY_PINS = Object.freeze({
  manifestSha256: "0219dce48d65e6413ce60d0aadfe1fe8047426c6570689ecaf77d757f256cda5",
  sourceTreeSha256: "6a8255fa538d6f2534d1784a088de9757283e8935e69a0d78a95358bb49ae197",
  dependencyTreeSha256: "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954",
  sourceFileCount: 74, dependencyFileCount: 1034, mobileWebStaticSha256: "1c57090fb35ac007620021a365e805f14d16a12a5b39f192bb7bd5f0a1bc1f66",
});
const MATCHED_MOBILE_EXPORT_RUN_ROOT = resolve(repoRoot, "target/private-phone-ux-validation/new-common-dependencies-before10feb-after992-20261009/run-d065c8c452c648f7");
const MATCHED_MOBILE_INPUT_ROOT = resolve(MATCHED_MOBILE_EXPORT_RUN_ROOT, "comparison-9925461c");
const MATCHED_MOBILE_SOURCE_SNAPSHOT = Object.freeze({
  root: resolve(repoRoot, "target/private-official-export-receipt-wiring-20261009/source-adapter-9925461c"),
  manifestSha256: "7d64b37bb56592f3e33dc222af0e58bf3a2cf44b72261092c42339acd30d935e", sourceCommit: "9925461ca047031f3f7f37d1f039d986c305fec3",
});
const MATCHED_MOBILE_INPUT_ROOTS = Object.freeze([
  Object.freeze({ name: "mobile", destination: "apps/kcoder-studio/mobile", sha256: "8a0963fb62846395dcdf1162470452d20fff84eed51adb44311fb75c5d327455", fileCount: 350 }),
  Object.freeze({ name: "studio-shared", destination: "apps/kcoder-studio/shared", sha256: "5443f5e695e75b82a1365baf90a3c280239bead8855647becfa2c9d67e91fe88", fileCount: 19 }),
]);
const MATCHED_MOBILE_INPUT = Object.freeze({
  comparisonId: "matched-deploy-mounted-191920",
  bundleRoot: resolve(MATCHED_MOBILE_INPUT_ROOT, "bundle"),
  exportManifestPath: resolve(MATCHED_MOBILE_INPUT_ROOT, "export-manifest.json"),
  expectedExportManifestSha256: "f2f262624d4a2286ef31e250fb1752e02ab9a41232196b5591dafc5d8369d14d",
  expectedBundleSha256: "e4a7277de6ecb2afb8f68dee52dfdf3b5a270c0e0c2e7f46cbdba02e83e140ab",
  expectedSourceTreeSha256: "b22dbddabf802b08a4a586de178c875b576a8279efc51d142a6f1948e40dd020",
  expectedDependencySourceTreeSha256: "46b02fc5ac823118f6eb2c034ea3f1d9cbbf79b71041fc2fa848f79a9abca1c6",
  expectedDependencyOwnedTreeSha256: "51b0c6987324fa5b6dbc17d8ea34ff83dd832deaa06c9c1193f84465a89001e4",
  expectedDependencyFileCount: 52_524, expectedInputRoots: MATCHED_MOBILE_INPUT_ROOTS,
});
const RUST_BINARY = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/worktree/2026/10/09/mobile-ux-followup-20261009/target/private-b6-device-revoke-20261009/build-03/owned-kcoder-copy";
const RUST_BINARY_PIN = Object.freeze({
  sha256: "bc985854134edffc02415a5d9e72f8905fdc23e7e2263e84f9554e53619dec29",
  bytes: 471_394_240,
});
const productionCaddy443Once = process.argv[2] === "--production-caddy-443-once";
const PUBLIC_ORIGIN = productionCaddy443Once ? "https://hyf2333.top" : "https://hyf2333.top:18453";
const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host;
const PUBLIC_DOMAIN = "hyf2333.top";
const PUBLIC_PORT = new URL(PUBLIC_ORIGIN).port ? Number(new URL(PUBLIC_ORIGIN).port) : 443;
const CERT_PATH = "/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/hyf2333.top/hyf2333.top.crt";
const KEY_PATH = "/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/hyf2333.top/hyf2333.top.key";
const CADDY_BIN = "/usr/bin/caddy";
const CADDY_VERSION_PIN = "2.6.2";
const CADDY_UID = 996;
const PRODUCTION_CADDY_CONFIG = "/etc/caddy/Caddyfile";
const PRODUCTION_CADDY_CONFIG_SHA256 = "05f6cab324663aed662c318ff54b30b67fa7ef36299419be63a8ba1bda71a511";
const PRODUCTION_CADDY_PID = 200738;
const PRODUCTION_CADDY_START_TICKS = 104133297;
const PRODUCTION_CADDY_ARGV_SHA256 = "1718eed11affa16fce6bc423c2933b283481c0f872508381ecaa9c744aa24510";
const PRODUCTION_CADDY_EXE_SHA256 = "9681d054b6e5137d53f6d027188b349e0603fd12ea6334bd0d49da6755432f1b";
const PRODUCTION_CADDY_PIN = Object.freeze({
  configPath: PRODUCTION_CADDY_CONFIG,
  configSha256: PRODUCTION_CADDY_CONFIG_SHA256,
  pid: PRODUCTION_CADDY_PID,
  startTicks: PRODUCTION_CADDY_START_TICKS,
  argvSha256: PRODUCTION_CADDY_ARGV_SHA256,
  exeSha256: PRODUCTION_CADDY_EXE_SHA256,
  version: CADDY_VERSION_PIN,
});
const TLS_PORT = 18_453;
const PROXY_FORWARD_PORT = 18_454;
const CONTROL_FORWARD_PORT = 18_455;
const SERVER_ID = "mobile-public-rust";
const RELAY_PATCH_ARTIFACT = resolve(repoRoot, "target/private-public-443-candidate-20261009/20261009-224546Z-3e01e747/inputs/relay-mount-proof/server.mount-proof.patch");

const staticOnly = process.argv[2] === "--static-check";
const localRegistrationOnly = process.argv[2] === "--local-registration-preflight";
const localCaddyRollbackOnly = process.argv[2] === "--local-caddy-rollback-preflight";
const caddyVersionReadonly = process.argv[2] === "--caddy-version-readonly";
const productionCaddyReadonly = process.argv[2] === "--production-caddy-readonly";
const productionCaddyRouteDryRun = process.argv[2] === "--production-caddy-route-dry-run";
const productionCaddyRecovery = process.argv[2] === "--recover-production-caddy-443";
const localProductionRollbackOnly = process.argv[2] === "--local-production-caddy-rollback-preflight";
const readonlyModes = staticOnly || localRegistrationOnly || localCaddyRollbackOnly || caddyVersionReadonly
  || productionCaddyReadonly || productionCaddyRouteDryRun || localProductionRollbackOnly;
assert.equal(process.argv.length, productionCaddyRecovery ? 4 : readonlyModes ? 3 : productionCaddy443Once ? 3 : 2);
if (readonlyModes || productionCaddyRecovery || productionCaddy443Once) {
  assert.notEqual(process.env[RUN_FLAG], "1", "this mode must not use the sidecar live-run flag");
} else {
  assert.equal(process.env[RUN_FLAG], "1", RUN_FLAG + "=1 is required for this private once-run");
}
if (productionCaddy443Once) {
  assert.equal(process.env.KCODER_E2E_PRODUCTION_CADDY_443_ONCE, "1", "production 443 mode requires its explicit private once flag");
  assert.notEqual(process.env[RUN_FLAG], "1", "production 443 mode and isolated sidecar mode are mutually exclusive");
} else {
  assert.notEqual(process.env.KCODER_E2E_PRODUCTION_CADDY_443_ONCE, "1", "production 443 flag requires --production-caddy-443-once");
}
assert.equal(process.execPath, EXPECTED_NODE);
assert.equal(process.version, "v22.17.0");
assert.equal(process.platform, "linux");
assert.equal(typeof process.getuid, "function");

if (staticOnly) {
  const staticEvidence = await runStaticCheck();
  await runLocalRustBinaryCopyFixture();
  process.stdout.write(JSON.stringify(staticEvidence) + "\n");
} else if (localRegistrationOnly) {
  await runLocalRegistrationPreflight();
} else if (localCaddyRollbackOnly) {
  await runLocalCaddyRollbackFixturePreflight();
} else if (caddyVersionReadonly) {
  await runReadonlyCaddyVersionProbe();
} else if (productionCaddyReadonly) {
  await runReadonlyProductionCaddyReview();
} else if (productionCaddyRouteDryRun) {
  await runReadonlyProductionCaddyReview({ routeDryRun: true });
} else if (localProductionRollbackOnly) {
  await runLocalProductionCaddyRollbackPreflight();
} else if (productionCaddyRecovery) {
  await runProductionCaddyRecovery(process.argv[3]);
} else {
let deferredProductionRecovery = null;
const publicRunPromise = runE2E(import.meta.url, {
  testId: "mobile-gateway-isolated-public-tls-once",
  tier: "manual-live",
  retainSuccessLogs: true,
  bodyAbortTimeoutMs: productionCaddy443Once ? 60_000 : 15_000,
  cleanupTimeoutMs: 180_000,
  modelPolicy: "one HTTPS Mobile Web load and UI pairing/Home/New through owned Relay and current Gateway using the matched Git 992 deploy-mounted export bundle; no Expo receipt claim, Rust execution, Provider, model turn, phone/native, RTT or performance claim",
}, async context => {
  const evidence = {
    state: "running", stage: "local-pinned-inputs", authority: "RunContext result.json and manifest.json",
    origin: { scheme: "https", host: PUBLIC_HOST },
    gateway: { mock: true, snapshotManifestSha256: null, sourceTreeSha256: null, dependencyTreeSha256: null, rustBinarySha256: null, rustBinaryConfiguredOnly: true, rustExecuted: false },
    mobile: { inputKind: "matched-export-derived-deploy-mount-manifest", comparisonId: MATCHED_MOBILE_INPUT.comparisonId,
      claimBoundary: "matched Git 992 bundle adapted for Gateway mounting; no official Expo receipt or new builder run claimed",
      sourceCommit: MATCHED_MOBILE_SOURCE_SNAPSHOT.sourceCommit, sourceSnapshotManifestSha256: MATCHED_MOBILE_SOURCE_SNAPSHOT.manifestSha256,
      exportManifestSha256: MATCHED_MOBILE_INPUT.expectedExportManifestSha256, bundleSha256: MATCHED_MOBILE_INPUT.expectedBundleSha256,
      derivedGatewayManifestSha256: null, resourceCount: null, totalResourceBytes: null },
    relay: { baseCommit: RELAY_COMMIT, baseServerSha256: RELAY_SERVER_BASE_SHA256, patchedServerSha256: null, patchSha256: null, sourceClosureSha256: null, wsVersion: null, wsPackageTreeSha256: null, registrationPostCount: 0, registrationStatus: null, controlOnline: false, identityFingerprint: null },
    remote: { candidatePorts: [PUBLIC_PORT, PROXY_FORWARD_PORT, CONTROL_FORWARD_PORT], preflightPassed: false, certificateSanValid: false, certificateExpires: null, caddyVersion: null, caddyPid: null, productionCaddyPid: null, productionRouteInstalled: false, productionRouteRestored: false, reverseTunnelPid: null, reverseForwardReadiness: { attemptCount: 0, attempts: [], final: "not-started", elapsedMs: null }, loopbackTlsEntry: null, caddyStopped: false, remoteRootRemoved: false, candidatePortsFreeAfterCleanup: false },
    localIngress: null,
    entry: { nodeStatus: null, nodeSchemaValid: false, browserStatus: null, browserRequestCount: 0, browserSchemaValid: false, safeFailureClass: null },
    browser: { outsideOriginRequests: 0, websocketCreated: 0, websocketWithFrames: 0, framesSent: 0, framesReceived: 0, pageErrors: 0 },
    pairing: { postObserved: false, status: null },
    assets: [], assetCaptureErrors: 0,
    ui: { welcomeVisible: false, homeOnlineVisible: false, newOpened: false, modelActionTriggered: false },
    cleanup: { localRelayClosed: false, localRelayClientClosed: false, caddyCleanup: "pending", tunnelCleanup: "pending", remoteRootCleanup: "pending", productionLease: productionCaddy443Once ? "pending" : "not-used" },
    claims: { physicalPhone: false, nativeRuntime: false, rttOrPerformance: false, liveFullBackendSourceSnapshot: false, productionServiceChanged: false },
    failureClass: null,
  };
  context.addCleanup("write safe isolated public TLS evidence", async () => {
    if (evidence.state === "running") evidence.state = "incomplete";
    await context.writeArtifactJsonInternal("isolated-public-tls-mobile-smoke.json", evidence);
  });

  let ownerContext = context;
  let leaseContext = null;
  let productionRestoreVerified = true;
  if (productionCaddy443Once) {
    leaseContext = await RunContext.create(import.meta.url, {
      testId: "mobile-gateway-production-caddy-443-resource-lease",
      tier: "manual-live", retainSuccessLogs: true, cleanupTimeoutMs: 120_000,
    });
    leaseContext.abortSignal = context.abortSignal;
    ownerContext = leaseContext;
  }

  let recovery = null;
  let recoveryFailure = null;
  let transaction = null;
  let remote = null;
  try {
    const relayInputs = await loadPinnedRelayInputs();
    evidence.relay.patchedServerSha256 = relayInputs.patchedServerSha256;
    evidence.relay.patchSha256 = relayInputs.patchSha256;
    evidence.relay.sourceClosureSha256 = relayInputs.sourceClosureSha256;
    evidence.relay.wsVersion = relayInputs.wsVersion;
    evidence.relay.wsPackageTreeSha256 = relayInputs.wsPackageTreeSha256;

    const gatewayHelpers = createMobileLatencyHelpers({ sha256: shaBytes });
    const gatewayRuntime = await gatewayHelpers.prepareGatewayRuntimeSnapshot(ownerContext, GATEWAY_SNAPSHOT);
    assert.equal(gatewayRuntime.manifestSha256, GATEWAY_PINS.manifestSha256);
    assert.equal(gatewayRuntime.manifest.sourceTreeSha256, GATEWAY_PINS.sourceTreeSha256);
    assert.equal(gatewayRuntime.manifest.dependencyTreeSha256, GATEWAY_PINS.dependencyTreeSha256);
    assert.equal(gatewayRuntime.manifest.status, "complete");
    assert.equal(gatewayRuntime.manifest.nodeVersion, "v22.17.0");
    assert.equal(gatewayRuntime.manifest.sourceFiles.length, GATEWAY_PINS.sourceFileCount);
    assert.equal(gatewayRuntime.manifest.dependencyFiles.length, GATEWAY_PINS.dependencyFileCount);
    assert.equal(await shaFile(resolve(gatewayRuntime.root, "src/mobile-web-static.js")), GATEWAY_PINS.mobileWebStaticSha256);
    evidence.gateway.snapshotManifestSha256 = gatewayRuntime.manifestSha256;
    evidence.gateway.sourceTreeSha256 = gatewayRuntime.manifest.sourceTreeSha256;
    evidence.gateway.dependencyTreeSha256 = gatewayRuntime.manifest.dependencyTreeSha256;

    const mobileSourceSnapshot = await verifyMatchedMobileSourceSnapshot();
    context.addCleanup("verify matched Git 992 source adapter after run", async () => {
      assert.deepEqual(await verifyMatchedMobileSourceSnapshot(), mobileSourceSnapshot);
    });
    const mobileDist = await materializeMatchedMobileStaticDist(ownerContext, MATCHED_MOBILE_INPUT);
    assert.equal(mobileDist.inputKind, "matched-export-derived-deploy-mount-manifest");
    assert.equal(mobileDist.comparisonId, MATCHED_MOBILE_INPUT.comparisonId);
    assert.equal(mobileDist.resourceCount, 37);
    const entryScripts = mobileDist.resources.filter(row => /^_expo\/static\/js\/web\/entry-[a-f0-9]+\.js$/.test(row.path));
    assert.equal(entryScripts.length, 1);
    const entryBundle = await readFile(join(mobileDist.ownedRoot, entryScripts[0].path), "utf8");
    for (const needle of ["welcome-direct-connection", "gateway-endpoint", "gateway-token", "gateway-connect",
      "new-workspace-", "workspace-path", "model-selector", "online"]) assert.ok(entryBundle.includes(needle));
    evidence.mobile = { inputKind: mobileDist.inputKind, comparisonId: mobileDist.comparisonId,
      claimBoundary: "matched Git 992 bundle adapted for Gateway mounting; no official Expo receipt or new builder run claimed",
      sourceCommit: mobileSourceSnapshot.sourceCommit, sourceSnapshotPath: mobileSourceSnapshot.sourceSnapshotPath,
      sourceSnapshotManifestSha256: mobileSourceSnapshot.sourceSnapshotManifestSha256,
      sourceSnapshotVerifiedGitBlobs: mobileSourceSnapshot.verifiedGitBlobs,
      exportManifestSha256: mobileDist.sourceExportManifestSha256, bundleSha256: mobileDist.sourceBundleSha256,
      sourceTreeSha256: mobileDist.sourceTreeSha256, derivedGatewayManifestSha256: mobileDist.manifestSha256,
      resourceCount: mobileDist.resourceCount, totalResourceBytes: mobileDist.totalResourceBytes };

    const rustBinary = await copyPinnedRustBinary(ownerContext);
    evidence.gateway.rustBinarySha256 = rustBinary.sha256; evidence.gateway.rustBinaryBytes = rustBinary.bytes;
    const runtimeRoot = ownerContext.pathInState("relay-runtime");
    await materializePinnedRelayRuntime(ownerContext, runtimeRoot, relayInputs.files, relayInputs.patchedServer);

    const workspace = await materializeWorkspace(ownerContext, "minimal", { instanceId: "isolated-public-mobile-rust" });
    const gatewayHome = ownerContext.pathInState("gateway-home");
    const gatewayConfig = ownerContext.pathInState("gateway-config");
    await Promise.all([
      mkdir(gatewayHome, { recursive: true, mode: 0o700 }),
      mkdir(gatewayConfig, { recursive: true, mode: 0o700 }),
    ]);
    const settingsFile = await ownerContext.writeStateJson("gateway-config/settings.json", {
      hooks: {},
      active_provider: "once-no-call",
      providers: { "once-no-call": {
        api_format: "openai_chat_completions",
        endpoint: "http://127.0.0.1:9/v1",
        default_model: "once-no-call",
        context_window_tokens: 8192,
        output_headroom_tokens: 1024,
        max_output_tokens: 1024,
        discover_models: false,
        no_proxy: true,
      } },
    });
    const dummyKey = "isolated-public-no-provider-call";
    ownerContext.registerSecret(dummyKey); context.registerSecret(dummyKey);
    await ownerContext.writeStateJson("gateway-config/credentials.json", { "once-no-call": { type: "api", key: dummyKey } });

    const registrationKey = randomBytes(32).toString("hex");
    const pairingToken = randomBytes(32).toString("hex");
    ownerContext.registerSecret(registrationKey); context.registerSecret(registrationKey);
    ownerContext.registerSecret(pairingToken); context.registerSecret(pairingToken);
    const serversFile = await ownerContext.writeStateJson("servers.json", [{
      id: SERVER_ID, label: "Configured Rust B6 mock target", runtime: "kcoder", transport: "local",
      command: rustBinary.path, workspacePath: workspace.path, settingsFile,
    }]);
    const gateway = await startGateway(ownerContext, {
      label: "isolated-public-mobile-current-gateway",
      auth: true, authToken: pairingToken,
      gatewayRoot: gatewayRuntime.root, cwd: gatewayRuntime.root,
      workspace: workspace.path, serversFile,
      serversStore: ownerContext.pathInState("servers-store.json"),
      kcoderBin: rustBinary.path,
      allowedHosts: PUBLIC_DOMAIN + ",127.0.0.1,localhost,::1",
      env: {
        KCODER_STUDIO_MOCK: "1",
        KCODER_STUDIO_PUBLIC_ORIGINS: PUBLIC_ORIGIN,
        KCODER_STUDIO_MOBILE_WEB_ORIGINS: PUBLIC_ORIGIN,
        KCODER_STUDIO_MOBILE_WEB_ROOT: mobileDist.ownedRoot,
        KCODER_STUDIO_WEB_ROOT: ownerContext.pathInState("unused-desktop-web-root"),
        KCODER_STUDIO_SECURE_COOKIE: "1",
        KCODER_CONFIG_DIR: gatewayConfig,
        KCODER_HOME: gatewayHome,
      },
    });
    assert.equal(gateway.child.spawnfile, process.execPath);
    assert.equal(gateway.child.spawnargs.at(-1), gateway.scriptPath);

    const relayModuleUrl = pathToFileURL(join(runtimeRoot, "apps/kcoder-relay/src/server.mjs")).href;
    const clientModuleUrl = pathToFileURL(join(runtimeRoot, "apps/kcoder-relay/src/client.mjs")).href;
    const relayModule = await import(relayModuleUrl);
    const relayClientModule = await import(clientModuleUrl);
    const registrationStore = ownerContext.pathInState("relay/registration-store.json");
    await mkdir(dirname(registrationStore), { recursive: true, mode: 0o700 });
    const relay = await relayModule.startRelay({
      gateways: [], sharedHosts: [PUBLIC_HOST], registrationKey, registrationStoreFile: registrationStore,
      controlPort: 0, proxyPort: 0,
    });
    ownerContext.registerPort("owned local Relay control", relay.controlPort);
    ownerContext.registerPort("owned local Relay public proxy", relay.proxyPort);
    ownerContext.addCleanup("close owned local Relay", async () => {
      await relay.close();
      evidence.cleanup.localRelayClosed = true;
    });

    const identityFile = ownerContext.pathInState("relay/client-identity.json");
    let relayOnline = false;
    const registrationObserver = createRegistrationFetchObserver({
      expectedOrigin: "http://127.0.0.1:" + relay.controlPort,
      onForward: count => { evidence.relay.registrationPostCount = count; },
      onResponse: status => { evidence.relay.registrationStatus = status; },
    });
    const relayClient = await relayClientModule.startRegisteredClient({
      url: "http://127.0.0.1:" + relay.controlPort,
      registrationKey, pairingToken, identityFile,
      gateway: gateway.baseUrl, allowInsecure: true, retryMs: 250,
      onOnline: () => { relayOnline = true; },
      fetchImpl: registrationObserver.fetchImpl,
    });
    ownerContext.addCleanup("close owned local Relay client", () => {
      relayClient.close();
      evidence.cleanup.localRelayClientClosed = true;
    });
    await waitFor(() => relayOnline, 20_000, "owned Relay control channel online to current Gateway", 50, ownerContext.abortSignal);
    assert.equal(registrationObserver.forwardCount, 1, "only one isolated run-owned Relay identity is created");
    assert.equal(registrationObserver.responseStatus, 201);
    assert.equal(evidence.relay.registrationPostCount, 1);
    assert.equal(evidence.relay.registrationStatus, 201);
    evidence.relay.controlOnline = true;
    const identity = JSON.parse(await readFile(identityFile, "utf8"));
    assert.match(identity.id, /^[a-f0-9]{32}$/);
    assert.equal(typeof identity.secret, "string");
    ownerContext.registerSecret(identity.id); context.registerSecret(identity.id);
    ownerContext.registerSecret(identity.secret); context.registerSecret(identity.secret);
    evidence.relay.identityFingerprint = shaBytes(Buffer.from(identity.id)).slice(0, 16);

    const sshConfig = requireAbsolute("KCODER_E2E_PUBLIC_SSH_CONFIG");
    const sshKnownHosts = requireAbsolute("KCODER_E2E_PUBLIC_SSH_KNOWN_HOSTS");
    const sshTarget = process.env.KCODER_E2E_PUBLIC_SSH_TARGET || "aliyun";
    assert.match(sshTarget, /^[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?$/);
    await Promise.all([sshConfig, sshKnownHosts].map(assertRegularNoSymlink));
    const sshOptions = [
      "-F", sshConfig, "-o", "UserKnownHostsFile=" + sshKnownHosts,
      "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes",
      "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=15",
    ];
    const managedSsh = await startOwnedSshControlMaster(ownerContext, {
      binary: SSH_BIN, target: sshTarget, configPath: sshConfig, knownHostsPath: sshKnownHosts, cwd: repoRoot,
    });
    const dispatcher = createOwnedSshDispatcher({
      primaryContext: ownerContext, managedTransport: managedSsh, binary: SSH_BIN, target: sshTarget, directOptions: sshOptions,
    });
    ownerContext.spawnRemoteSsh = (label, command, options) => dispatcher.spawn(ownerContext, label, command, options);
    recovery = await RunContext.create(import.meta.url, {
      testId: "mobile-gateway-isolated-public-tls-once-recovery",
      tier: "manual-live", retainSuccessLogs: true, cleanupTimeoutMs: 120_000,
    });
    dispatcher.attachRecoveryContext(recovery);
    recovery.spawnRemoteSsh = (label, command, options) => dispatcher.spawn(recovery, label, command, options);
    remote = makeRemoteIo({ primary: ownerContext, recovery, dispatcher });
    const runId = shaBytes(Buffer.from("isolated-public-tls:" + context.seed)).slice(0, 24);
    transaction = {
      runId, root: "/tmp/kc-mobile-isolated-tls-" + runId, marker: runId,
      identity: null, rootCreateAttempted: false, launchAttempted: false,
      caddyPid: null, configSha256: null, cleanedRoot: false, stoppedCaddy: false,
      productionRouteAttempted: false, productionRouteInstalled: false, candidateConfigSha256: null,
      gatewayId: null, snippet: null,
    };
    context.addCleanup("finish isolated TLS SSH recovery context", async () => {
      if (productionCaddy443Once && !productionRestoreVerified) {
        evidence.cleanup.sshRecoveryContext = "retained-for-external-route-recovery";
        return;
      }
      await recovery.finish(recoveryFailure ? "failed" : "passed", {
        parentRunRoot: context.runRoot,
        remoteCaddyStopped: transaction.stoppedCaddy,
        remoteRootRemoved: transaction.cleanedRoot,
      }, recoveryFailure);
    });
    context.addCleanup("verify isolated remote TLS ports released", async () => {
      if (!transaction.rootCreateAttempted) return;
      if (productionCaddy443Once && !productionRestoreVerified) {
        evidence.cleanup.remoteRootCleanup = "retained-for-route-recovery";
        return;
      }
      const result = await remote.verifyFinal(transaction);
      evidence.remote.candidatePortsFreeAfterCleanup = result.portsFree;
      assert.equal(result.portsFree, true);
      assert.equal(result.rootAbsent, true);
    });
    context.addCleanup("remove exact owned isolated Caddy root", async () => {
      if (!transaction.rootCreateAttempted) return;
      if (productionCaddy443Once && !productionRestoreVerified) {
        evidence.cleanup.remoteRootCleanup = "retained-for-route-recovery";
        return;
      }
      try {
        const result = await remote.removeRoot(transaction);
        assert.equal(result.removed, true);
        transaction.cleanedRoot = true;
        evidence.remote.remoteRootRemoved = true;
        evidence.cleanup.remoteRootCleanup = "PASS";
      } catch (error) {
        recoveryFailure ??= error;
        evidence.cleanup.remoteRootCleanup = "FAIL";
        throw error;
      }
    });
    if (productionCaddy443Once) {
      context.addCleanup("finish production Gateway Relay lease after route restoration", async () => {
        if (!productionRestoreVerified) {
          evidence.cleanup.productionLease = "retained-for-exact-route-recovery";
          return;
        }
        await ownerContext.finish(evidence.state === "PASS" ? "passed" : "failed", {
          parentRunRoot: context.runRoot, productionRouteRestored: true,
        });
        evidence.cleanup.productionLease = "released-after-restore";
      });
    }

    const remoteBefore = await remote.preflight();
    const expectedFreePorts = productionCaddy443Once
      ? { "18454": "free", "18455": "free" }
      : { "18453": "free", "18454": "free", "18455": "free" };
    assert.deepEqual(remoteBefore.ports, expectedFreePorts);
    assert.equal(remoteBefore.certificate.sanValid, true);
    evidence.remote.preflightPassed = true;
    evidence.remote.certificateSanValid = true;
    evidence.remote.certificateExpires = remoteBefore.certificate.notAfter;
    evidence.remote.caddyVersion = remoteBefore.caddy.version;

    transaction.rootCreateAttempted = true;
    transaction.identity = await remote.createRoot(transaction);
    const syntaxPath = transaction.root + "/server.mount-proof-check.mjs";
    await remote.writeCaddyOwned(syntaxPath, Buffer.from(relayInputs.patchedServer));
    const node18 = (await remote.output("verify-remote-node18", "sudo -n -u caddy -- " + shellQuote(REMOTE_NODE18) + " --version")).trim();
    assert.match(node18, /^v18\./, "modified Relay server requires the remote Node 18 syntax gate");
    evidence.remote.node18Version = node18;
    await remote.output("node18-check-mount-proof-server", "sudo -n -u caddy -- " + shellQuote(REMOTE_NODE18) + " --check " + shellQuote(syntaxPath));
    await remote.removeCaddyOwned(syntaxPath);
    const caddyfile = buildCaddyfile(identity.id);
    transaction.configSha256 = shaBytes(Buffer.from(caddyfile));
    await remote.writeCaddyOwned(transaction.root + "/Caddyfile", Buffer.from(caddyfile));
    await remote.output("validate-isolated-caddy-config", caddyCommand(transaction.root, "validate"));

    const tunnelArgs = [
      "-T", ...sshOptions, "-o", "ClearAllForwardings=no", "-o", "ExitOnForwardFailure=yes", "-N",
      "-R", "127.0.0.1:" + PROXY_FORWARD_PORT + ":127.0.0.1:" + relay.proxyPort,
      "-R", "127.0.0.1:" + CONTROL_FORWARD_PORT + ":127.0.0.1:" + relay.controlPort,
      sshTarget,
    ];
    const tunnel = ownerContext.spawnOwned("isolated-public-tls-reverse-forward", SSH_BIN, tunnelArgs, {
      cwd: repoRoot, env: ownerContext.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
    });
    evidence.remote.reverseTunnelPid = tunnel.pid;
    assert.equal(tunnel.spawnfile, SSH_BIN);
    assert.deepEqual(tunnel.spawnargs, [SSH_BIN, ...tunnelArgs]);
    context.addCleanup("record owned reverse tunnel cleanup request", () => {
      evidence.cleanup.tunnelCleanup = "requested";
    });
    const readiness = evidence.remote.reverseForwardReadiness;
    const readinessStartedAt = performance.now();
    try {
      await waitFor(async () => {
        const tunnelAlive = tunnel.exitCode === null && tunnel.signalCode === null;
        if (!tunnelAlive) {
          readiness.final = "tunnel-exited";
          readiness.elapsedMs = Math.round(performance.now() - readinessStartedAt);
          throw new Error("owned reverse-forward tunnel exited before both remote probes succeeded");
        }
        const forwards = await remote.verifyForwards(5_000);
        const stillAlive = tunnel.exitCode === null && tunnel.signalCode === null;
        const state = classifyReverseForwardReadiness({ tunnelAlive: stillAlive, ...forwards });
        readiness.attempts.push({
          elapsedMs: Math.round(performance.now() - readinessStartedAt),
          proxyForwardReachable: forwards.proxyForwardReachable,
          controlForwardReachable: forwards.controlForwardReachable,
          state,
        });
        readiness.attemptCount = readiness.attempts.length;
        readiness.final = state;
        readiness.elapsedMs = Math.round(performance.now() - readinessStartedAt);
        if (state === "tunnel-exited") throw new Error("owned reverse-forward tunnel exited before both remote probes succeeded");
        return state === "ready";
      }, 20_000, "both owned SSH reverse forwards become remotely reachable", 300, ownerContext.abortSignal);
    } catch (error) {
      if (readiness.final === "pending") readiness.final = "timeout-or-probe-failure";
      readiness.elapsedMs = Math.round(performance.now() - readinessStartedAt);
      throw error;
    }

    if (!productionCaddy443Once) {
      context.addCleanup("stop exact owned isolated Caddy process", async () => {
        if (!transaction.launchAttempted) return;
        try {
          const result = await remote.stopCaddy(transaction);
          assert.equal(result.stopped, true);
          transaction.stoppedCaddy = true;
          evidence.remote.caddyStopped = true;
          evidence.cleanup.caddyCleanup = "PASS";
        } catch (error) {
          recoveryFailure ??= error;
          evidence.cleanup.caddyCleanup = "FAIL";
          throw error;
        }
      });
      transaction.launchAttempted = true;
      const caddyStarted = await remote.startCaddy(transaction);
      transaction.caddyPid = caddyStarted.pid;
      evidence.remote.caddyPid = caddyStarted.pid;
      assert.equal(caddyStarted.ready, true);
      const owners = await remote.inspectCandidate(transaction);
      assert.equal(owners.caddyOwnsTlsPort, true);
      assert.equal(owners.proxyForwardReachable, true);
      assert.equal(owners.controlForwardReachable, true);
    } else {
      const snippet = buildProduction443RouteSnippet(runId, identity.id);
      const review = await remote.inspectProductionCandidate(runId, identity.id, snippet);
      const candidateReview = review.candidateReview;
      assert.equal(review.remoteWrites, false);
      assert.equal(review.serviceChanged, false);
      assert.equal(review.process.pid, PRODUCTION_CADDY_PIN.pid);
      assert.equal(review.process.startTicks, PRODUCTION_CADDY_PIN.startTicks);
      assert.equal(review.process.argvSha256, PRODUCTION_CADDY_PIN.argvSha256);
      assert.equal(review.process.exeSha256, PRODUCTION_CADDY_PIN.exeSha256);
      assert.equal(review.process.configPath, PRODUCTION_CADDY_PIN.configPath);
      assert.equal(review.config.sha256, PRODUCTION_CADDY_PIN.configSha256);
      assert.equal(review.config.uid, 0);
      assert.equal(review.config.gid, 0);
      assert.equal(review.config.mode, "0o644");
      for (const key of ["guardsPass", "candidateAdaptJsonValid", "routeAssertionsPass", "selectedBeforeCatchall",
        "relayUnchanged", "catchallUnchanged", "otherRoutesUnchanged"]) assert.equal(candidateReview[key], true);
      assert.equal(candidateReview.insertionAnchorCount, 1);
      transaction.gatewayId = identity.id;
      transaction.snippet = snippet;
      transaction.candidateConfigSha256 = candidateReview.candidateConfigSha256;
      assert.match(transaction.candidateConfigSha256, /^[a-f0-9]{64}$/);
      const publicTransaction = {
        version: 1, mode: "production-caddy-443-selected-gateway-route", runId,
        configPath: PRODUCTION_CADDY_PIN.configPath, pin: PRODUCTION_CADDY_PIN,
        originalConfigSha256: PRODUCTION_CADDY_PIN.configSha256,
        candidateConfigSha256: transaction.candidateConfigSha256,
        backupLeaf: ".Caddyfile.kcux-" + runId + ".backup",
        routeSnippetSha256: shaBytes(Buffer.from(snippet)),
        selectedGatewayFingerprint: shaBytes(Buffer.from(identity.id)).slice(0, 16),
      };
      await context.writeArtifactJson("production-caddy-443-transaction.json", publicTransaction);
      const ownerFence = await currentProcessFence();
      assert.equal(ownerFence.exePath, await realpath(EXPECTED_NODE));
      await writeDurableRecoveryIntent(context, { version: 1, state: "READY_FOR_APPLY", runRoot: context.runRoot,
        runId, ownerFence, transaction: publicTransaction, exactRecoveryCommand: productionRecoveryCommand(context.runRoot) });
      context.addCleanup("restore exact pinned production Caddy config before releasing Gateway Relay lease", async () => {
        if (!transaction.productionRouteAttempted) { productionRestoreVerified = true; return; }
        try {
          const restored = await remote.restoreProductionRoute(transaction);
          assert.equal(restored.restored, true);
          assert.ok(restored.reloaded === true || restored.alreadyOriginal === true);
          assert.equal(restored.configSha256, PRODUCTION_CADDY_PIN.configSha256);
          assert.equal(restored.caddyPid, PRODUCTION_CADDY_PIN.pid);
          productionRestoreVerified = true;
          evidence.remote.productionRouteRestored = true;
          evidence.cleanup.productionRouteRestore = "PASS";
        } catch (error) {
          evidence.state = "FAIL";
          evidence.stage = "production-route-restore-failed";
          evidence.failureClass = safeFailureClass(error);
          productionRestoreVerified = false;
          recoveryFailure ??= error;
          evidence.cleanup.productionRouteRestore = "FAIL_REQUIRES_EXACT_RECOVERY";
          deferredProductionRecovery = {
            runRoot: context.runRoot, context, ownerContext, recovery, remote, transaction,
            evidence, recoveryFailure: error,
          };
          await context.writeArtifactJsonInternal("production-caddy-443-recovery-required.json", {
            state: "RECOVERY_REQUIRED", runRoot: context.runRoot, runId,
            originalConfigSha256: PRODUCTION_CADDY_PIN.configSha256,
            candidateConfigSha256: transaction.candidateConfigSha256,
            exactRecoveryCommand: productionRecoveryCommand(context.runRoot),
            forwardAndRelayRetained: true,
          });
          throw error;
        }
      });
      const rootInvocation = await remote.verifyProductionRootInvocation();
      evidence.remote.productionWriteEuid = rootInvocation.euid;
      evidence.remote.productionSshUser = rootInvocation.sshUser;
      evidence.remote.productionSshEuid = rootInvocation.sshEuid;
      transaction.productionRouteAttempted = true;
      const installed = await remote.installProductionRoute(transaction);
      transaction.productionRouteInstalled = true;
      evidence.remote.productionRouteInstalled = true;
      evidence.remote.productionCaddyPid = installed.caddyPid;
      evidence.claims.productionServiceChanged = true;
      const installedSnapshot = await remote.inspectProductionInstalled();
      const selectedRows = installedSnapshot.config.routes.filter(row => row.paths.length === 2
        && row.paths[0] === "/g/<ID>" && row.paths[1] === "/g/<ID>/*"
        && row.hosts.includes(PUBLIC_DOMAIN) && row.handler === "reverse_proxy"
        && row.upstreams.some(upstream => upstream.loopback && upstream.port === String(PROXY_FORWARD_PORT))
        && row.hostHeaderSet === true && row.flushInterval === -1);
      const catchallRows = installedSnapshot.config.routes.filter(row => row.paths.includes("/g/*")
        && row.upstreams.some(upstream => upstream.loopback && upstream.port === "80"));
      assert.equal(installedSnapshot.service.activeState, "active");
      assert.equal(installedSnapshot.process.pid, PRODUCTION_CADDY_PIN.pid);
      assert.equal(installedSnapshot.process.startTicks, PRODUCTION_CADDY_PIN.startTicks);
      assert.equal(installedSnapshot.process.argvSha256, PRODUCTION_CADDY_PIN.argvSha256);
      assert.equal(installedSnapshot.process.exeSha256, PRODUCTION_CADDY_PIN.exeSha256);
      assert.equal(installedSnapshot.config.sha256, transaction.candidateConfigSha256);
      assert.equal(selectedRows.length, 1);
      assert.equal(catchallRows.length, 1);
      const orderBefore = (left, right) => {
        const a = left.split(".").map(Number), b = right.split(".").map(Number);
        for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
          if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0);
        }
        return false;
      };
      assert.equal(orderBefore(selectedRows[0].order, catchallRows[0].order), true);
    }

    const mount = "/g/" + identity.id + "/mobile";
    const entryPath = "/g/" + identity.id + "/mobile-entry";
    const gatewayBase = PUBLIC_ORIGIN + "/g/" + identity.id;
    const mobileUrl = PUBLIC_ORIGIN + mount + "/";
    const pairingPath = "/g/" + identity.id + "/api/mobile/session";
    evidence.stage = "remote-loopback-and-public-ingress-diagnostics";
    evidence.remote.loopbackTlsEntry = await remote.readLoopbackTlsEntry(identity.id);
    evidence.localIngress = await probePublicIngressPorts();
    if (!evidence.remote.loopbackTlsEntry.tlsVerified || evidence.remote.loopbackTlsEntry.status !== 200
        || !evidence.remote.loopbackTlsEntry.schemaValid || !evidence.remote.loopbackTlsEntry.urlsMatchExpectedMount) {
      throw new Error("remote loopback HTTPS Mobile entry did not pass TLS, status, and schema checks");
    }
    evidence.stage = "public-mobile-entry-and-browser";
    const nodeEntry = await fetchEntry(PUBLIC_ORIGIN + entryPath, 10_000);
    evidence.entry.nodeStatus = nodeEntry.status;
    const nodeEntryValidation = validateMobileEntry(nodeEntry.body, {
      mobileUrl, gatewayBase, pairingToken, relaySecret: identity.secret,
    });
    evidence.entry.nodeSchemaValid = nodeEntryValidation.valid;
    assert.equal(nodeEntry.status, 200);
    assert.equal(nodeEntryValidation.valid, true);

    const browser = await startChromium(context, { label: "isolated-public-mobile-chromium", noSandbox: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const assetTasks = [];
    page.on("request", request => {
      try {
        const url = new URL(request.url());
        if (["http:", "https:", "ws:", "wss:"].includes(url.protocol)
          && (url.host !== PUBLIC_HOST || !["https:", "wss:"].includes(url.protocol)))
          evidence.browser.outsideOriginRequests += 1;
        if (url.origin === PUBLIC_ORIGIN && url.pathname === pairingPath && request.method() === "POST")
          evidence.pairing.postObserved = true;
        if (url.origin === PUBLIC_ORIGIN && url.pathname === entryPath && request.method() === "GET" && !url.search && !url.hash)
          evidence.entry.browserRequestCount += 1;
      } catch {
        evidence.browser.outsideOriginRequests += 1;
      }
    });
    page.on("requestfailed", request => {
      try {
        const url = new URL(request.url());
        if (url.origin === PUBLIC_ORIGIN && url.pathname === entryPath)
          evidence.entry.safeFailureClass = safeNetworkFailure(request.failure()?.errorText ?? "");
      } catch {}
    });
    page.on("pageerror", () => { evidence.browser.pageErrors += 1; });
    page.on("websocket", socket => {
      let url;
      try { url = new URL(socket.url()); } catch { return; }
      if (url.protocol !== "wss:" || url.host !== PUBLIC_HOST) return;
      evidence.browser.websocketCreated += 1;
      let framed = false;
      const observe = key => {
        evidence.browser[key] += 1;
        if (!framed) {
          framed = true;
          evidence.browser.websocketWithFrames += 1;
        }
      };
      socket.on("framesent", () => observe("framesSent"));
      socket.on("framereceived", () => observe("framesReceived"));
    });
    page.on("response", response => {
      try {
        const url = new URL(response.url());
        if (url.origin !== PUBLIC_ORIGIN || !(url.pathname === mount + "/" || url.pathname.startsWith(mount + "/"))) return;
        if (evidence.assets.length + assetTasks.length >= 96) return;
        const task = captureAsset(response, assetKind(url.pathname, response.request().resourceType()))
          .then(row => { if (row) evidence.assets.push(row); })
          .catch(() => { evidence.assetCaptureErrors += 1; });
        assetTasks.push(task);
      } catch {
        evidence.assetCaptureErrors += 1;
      }
    });
    page.on("response", response => {
      try {
        const url = new URL(response.url());
        if (url.origin === PUBLIC_ORIGIN && url.pathname === entryPath && !url.search && !url.hash)
          evidence.entry.browserStatus = response.status();
        if (url.origin === PUBLIC_ORIGIN && url.pathname === pairingPath && response.request().method() === "POST")
          evidence.pairing.status = response.status();
      } catch {}
    });

    const htmlResponse = await page.goto(mobileUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert.equal(htmlResponse?.status(), 200, "actual Mobile Web HTML loads through public TLS and the isolated Relay");
    const browserEntry = await page.evaluate(async path => {
      try {
        const response = await fetch(path, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store" });
        try { return { status: response.status, payload: await response.json() }; }
        catch { return { status: response.status, payload: null }; }
      } catch {
        return { status: null, payload: null };
      }
    }, entryPath);
    evidence.entry.browserStatus ??= browserEntry.status;
    const browserEntryValidation = validateMobileEntry(browserEntry.payload, {
      mobileUrl, gatewayBase, pairingToken, relaySecret: identity.secret,
    });
    evidence.entry.browserSchemaValid = browserEntryValidation.valid;
    assert.equal(evidence.entry.browserStatus, 200);
    assert.equal(evidence.entry.browserRequestCount, 1);
    assert.equal(browserEntryValidation.valid, true);

    const welcome = page.getByTestId("welcome-direct-connection");
    await welcome.waitFor({ state: "visible", timeout: 30_000 });
    evidence.ui.welcomeVisible = true;
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await welcome.click();
    await page.getByTestId("gateway-endpoint").fill(gatewayBase);
    await page.getByTestId("gateway-token").fill(pairingToken);
    const pairResponse = page.waitForResponse(response => {
      try {
        const url = new URL(response.url());
        return url.origin === PUBLIC_ORIGIN && url.pathname === pairingPath && response.request().method() === "POST";
      } catch {
        return false;
      }
    }, { timeout: 30_000 });
    await page.getByTestId("gateway-connect").click();
    assert.equal((await pairResponse).status(), 200);
    await page.waitForURL(/\/h\/[^/?#]+(?:\/|$)/, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[aria-label="online"]') !== null, undefined, { timeout: 30_000 });
    evidence.ui.homeOnlineVisible = true;
    await page.getByTestId("new-workspace-" + SERVER_ID).click();
    await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("model-selector").waitFor({ state: "visible", timeout: 30_000 });
    evidence.ui.newOpened = true;
    await Promise.all(assetTasks);
    evidence.assetSummary = summarizeAssets(evidence.assets);
    assert.ok(evidence.assets.some(row => row.kind === "html" && row.status === 200));
    assert.ok(evidence.assets.some(row => row.kind === "javascript" && row.status === 200));
    assert.ok(evidence.assets.some(row => row.kind === "css" && row.status === 200));
    assert.equal(evidence.assetCaptureErrors, 0);
    assert.equal(evidence.browser.outsideOriginRequests, 0);
    assert.ok(evidence.browser.websocketWithFrames > 0);
    assert.equal(evidence.relay.registrationPostCount, 1);
    assert.equal(evidence.relay.registrationStatus, 201);
    evidence.state = "PASS";
    evidence.stage = "complete";
  } catch (error) {
    evidence.state = "FAIL";
    evidence.failureClass = safeFailureClass(error);
    if (error?.name === "TimeoutError") evidence.entry.safeFailureClass = "timeout";
    if (error?.safeCode) evidence.entry.safeFailureClass = error.safeCode;
    throw error;
  }
});
let publicRunFailure = null;
try {
  await publicRunPromise;
} catch (error) {
  publicRunFailure = error;
}
if (deferredProductionRecovery) await completeDeferredProductionRecovery(deferredProductionRecovery);
if (publicRunFailure) throw publicRunFailure;
}

async function completeDeferredProductionRecovery(deferred) {
  const { runRoot, context, ownerContext, recovery, remote, transaction, evidence, recoveryFailure } = deferred;
  const recoveryCommand = productionRecoveryCommand(runRoot);
  process.stderr.write("Production Caddy restore failed. The owned Gateway/Relay/forward lease is retained.\n"
    + "Run this exact local recovery command in another terminal: " + recoveryCommand + "\n");
  const ack = await waitForProductionRecoveryAck(runRoot, transaction);
  let leaseReleased = false, remoteRootRemoved = false, portsFree = false, recoveryContextFinished = false;
  const failures = [];
  try {
    await ownerContext.finish("failed", { parentRunRoot: runRoot, productionRouteRestored: true }, recoveryFailure);
    leaseReleased = true;
    evidence.cleanup.productionLease = "released-after-external-restore";
  } catch (error) {
    failures.push(safeFailureClass(error));
  }
  try {
    const removed = await remote.removeRoot(transaction);
    assert.equal(removed.removed, true);
    transaction.cleanedRoot = true;
    remoteRootRemoved = true;
    const terminal = await remote.verifyFinal(transaction);
    assert.equal(terminal.rootAbsent, true);
    assert.equal(terminal.portsFree, true);
    portsFree = true;
  } catch (error) {
    failures.push(safeFailureClass(error));
  }
  try {
    await recovery.finish("failed", { parentRunRoot: runRoot, externallyRestored: true,
      leaseReleased, remoteRootRemoved, portsFree }, recoveryFailure);
    recoveryContextFinished = true;
  } catch (error) {
    failures.push(safeFailureClass(error));
  }
  const receipt = {
    state: leaseReleased && remoteRootRemoved && portsFree && recoveryContextFinished
      ? "RESTORED_AND_OWNED_LEASE_CLEANED" : "RESTORED_BUT_LEASE_CLEANUP_INCOMPLETE",
    runRoot, runId: transaction.runId, originalConfigSha256: PRODUCTION_CADDY_PIN.configSha256,
    candidateConfigSha256: transaction.candidateConfigSha256, routeRestored: true,
    recoveryCommandAcknowledged: true, ackCaddyPid: ack.caddyPid,
    leaseReleased, remoteRootRemoved, portsFree, recoveryContextFinished,
    cleanupFailureClasses: failures,
  };
  await context.writeArtifactJsonInternal("production-caddy-443-recovery-completed.json", receipt);
  process.stderr.write("Production route restoration was confirmed; owned cleanup state: " + receipt.state + "\n");
}

async function waitForProductionRecoveryAck(runRoot, transaction) {
  const ackPath = join(runRoot, "artifacts", "production-caddy-443-recovery-ack.json");
  const notifySignal = signal => process.stderr.write("Received " + signal + "; retained lease remains active until the exact recovery command completes.\n");
  const onSigint = () => notifySignal("SIGINT");
  const onSigterm = () => notifySignal("SIGTERM");
  const onSighup = () => notifySignal("SIGHUP");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  try {
    while (true) {
      try {
        const ack = await readPrivateRunJson(ackPath, 4096);
        assert.deepEqual(Object.keys(ack).sort(), ["candidateConfigSha256", "caddyPid", "originalConfigSha256", "runId", "runRoot", "state"].sort());
        assert.equal(ack.state, "RESTORED");
        assert.equal(ack.runRoot, runRoot);
        assert.equal(ack.runId, transaction.runId);
        assert.equal(ack.originalConfigSha256, PRODUCTION_CADDY_PIN.configSha256);
        assert.equal(ack.candidateConfigSha256, transaction.candidateConfigSha256);
        assert.equal(ack.caddyPid, PRODUCTION_CADDY_PIN.pid);
        return ack;
      } catch (error) {
        if (error?.code !== "ENOENT") process.stderr.write("Recovery acknowledgment is not yet valid; retained lease remains active.\n");
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 1000));
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGHUP", onSighup);
  }
}

async function runProductionCaddyRecovery(runRootInput) {
  assert.ok(runRootInput.startsWith("/"));
  const runRoot = resolve(runRootInput);
  assert.equal(runRoot, runRootInput);
  const expectedBase = await realpath(PRODUCTION_RUN_ARTIFACT_ROOT);
  assert.equal(dirname(runRoot), expectedBase);
  assert.equal(await realpath(runRoot), runRoot);
  const rootInfo = await lstat(runRoot);
  assert.equal(rootInfo.isDirectory(), true); assert.equal(rootInfo.isSymbolicLink(), false); assert.equal(rootInfo.uid, process.getuid()); assert.equal(rootInfo.mode & 0o777, 0o700);
  const manifest = await readPrivateRunJson(join(runRoot, "manifest.json"), 64 * 1024);
  const intent = await readPrivateRunJson(join(runRoot, "artifacts", "production-caddy-443-recovery-intent.json"), 32 * 1024);
  const recoveryRequired = await readOptionalPrivateRunJson(join(runRoot, "artifacts", "production-caddy-443-recovery-required.json"));
  const transactionArtifact = await readPrivateRunJson(join(runRoot, "artifacts", "production-caddy-443-transaction.json"));
  const ownerState = await inspectProcessFence(intent.ownerFence);
  const plan = validateProductionRecoveryPlan({ runRoot, manifest, recoveryRequired, transaction: transactionArtifact, intent,
    ownerState, source: PRODUCTION_RUNNER_SOURCE, testId: "mobile-gateway-isolated-public-tls-once",
    expectedPin: PRODUCTION_CADDY_PIN, expectedExecutable: await realpath(EXPECTED_NODE),
    expectedRecoveryCommand: productionRecoveryCommand(runRoot) });
  const ackPath = join(runRoot, "artifacts", "production-caddy-443-recovery-ack.json");
  await lstat(ackPath).then(() => { throw new Error("recovery acknowledgment already exists; inspect the existing receipt"); }, error => {
    if (error?.code !== "ENOENT") throw error;
  });
  let ack = null;
  let parentDiedDuringRecovery = false;
  await runE2E(import.meta.url, {
    testId: "mobile-gateway-production-caddy-443-exact-recovery",
    tier: "manual-live", retainSuccessLogs: true, cleanupTimeoutMs: 90_000,
    modelPolicy: "restore only the exact pinned Caddy config from this RunContext's exact root-owned backup; no Gateway/Relay startup, config installation, route expansion, or process kill",
  }, async context => {
    const sshConfig = requireAbsolute("KCODER_E2E_PUBLIC_SSH_CONFIG");
    const sshKnownHosts = requireAbsolute("KCODER_E2E_PUBLIC_SSH_KNOWN_HOSTS");
    await Promise.all([sshConfig, sshKnownHosts].map(assertRegularNoSymlink));
    const target = process.env.KCODER_E2E_PUBLIC_SSH_TARGET || "aliyun";
    assert.match(target, /^[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?$/);
    const directOptions = ["-F", sshConfig, "-o", "UserKnownHostsFile=" + sshKnownHosts,
      "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "-o", "ControlMaster=no",
      "-o", "ControlPath=none", "-o", "ConnectTimeout=15"];
    const managed = await startOwnedSshControlMaster(context, {
      binary: SSH_BIN, target, configPath: sshConfig, knownHostsPath: sshKnownHosts, cwd: repoRoot,
    });
    const dispatcher = createOwnedSshDispatcher({ primaryContext: context, managedTransport: managed,
      binary: SSH_BIN, target, directOptions });
    const remote = makeRemoteIo({ primary: context, recovery: context, dispatcher });
    const restored = await remote.restoreProductionRoute(plan);
    assert.equal(restored.restored, true);
    assert.ok(restored.reloaded === true || restored.alreadyOriginal === true);
    ack = { state: "RESTORED", runRoot, runId: plan.runId,
      originalConfigSha256: PRODUCTION_CADDY_PIN.configSha256,
      candidateConfigSha256: plan.candidateConfigSha256, caddyPid: restored.caddyPid };
    if (plan.ownerState === "alive") {
      const finalOwnerState = await inspectProcessFence(intent.ownerFence);
      if (finalOwnerState === "dead") { ack = null; parentDiedDuringRecovery = true; }
      else assert.equal(finalOwnerState, "alive", "original run owner identity changed during recovery");
    } else ack = null;
    return { routeRestored: true, backupRemoved: restored.backupRemoved,
      candidateStageRemoved: restored.candidateStageRemoved, restoreStageRemoved: restored.restoreStageRemoved,
      alreadyOriginal: restored.alreadyOriginal, configSha256: restored.configSha256,
      originalRunOwnerState: plan.ownerState, parentDiedDuringRecovery, acknowledgmentWritten: Boolean(ack),
      remoteLeaseCleanupAttempted: false };
  });
  if (ack) await writePrivateRecoveryAck(ackPath, ack);
}
