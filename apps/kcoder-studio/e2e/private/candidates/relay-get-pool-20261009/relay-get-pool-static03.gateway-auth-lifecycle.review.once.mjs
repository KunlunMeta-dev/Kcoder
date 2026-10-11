// Private HTTP lifecycle proof for the frozen Relay GET pool and the pinned
// C22 Gateway runtime snapshot. Uses a test-only response-end hold in the real
// Gateway child; it does not use a browser, app-server, Provider, public host,
// production session, or modify either product source tree.
//
// Run only after the source pins and test-only boundaries are reviewed:
// KCODER_E2E_PRIVATE_RELAY_GET_POOL_STATIC03_C22=1 \
//   /home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node \
//   apps/kcoder-studio/e2e/private/candidates/relay-get-pool-20261009/relay-get-pool-static03.gateway-auth-lifecycle.review.once.mjs

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, runE2E } from "../../../harness/run-context.mjs";
import { startGateway } from "../../../harness/gateway.mjs";
import { validatePinnedGatewayRuntime } from "../../../harness/pinned-gateway.mjs";

const PRIVATE_RUN_FLAG = "KCODER_E2E_PRIVATE_RELAY_GET_POOL_STATIC03_C22";
const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const RELAY_FREEZE_ROOT = "target/private-phone-ux-implementation/relay-grant-get-pool-20261009/candidate-static03";
const RELAY_MANIFEST_PATH = `${RELAY_FREEZE_ROOT}/manifest.json`;
const RELAY_OVERLAY_ROOT = `${RELAY_FREEZE_ROOT}/source`;
const RELAY_BASELINE_ROOT = `${RELAY_FREEZE_ROOT}/before`;
const RELAY_TEST_ROOT = `${RELAY_FREEZE_ROOT}/tests`;
const RELAY_SUPPORT_RUNTIME_ROOT = "apps/kcoder-relay";
const RELAY_MANIFEST_SHA256 = "0a4378e704a2f9bd86d4cef268e91041aa68d6765547901581bcf01c25669bfe";
const RELAY_DESIGN_SHA256 = "cd8a4db5a2cba20e862b10e6934504b71372885728d87780c03324f2b58477ce";
const RELAY_SERVER_SHA256 = "9d0846a54a1062355c95723eab57e4a12942333a4c7fe17cbbb998f1b5a4067a";
const RELAY_POOL_SHA256 = "1ac7a3e9806c0e57a86300497139d34be9c6143d68d1b18f57e49ba72742c923";
const WS_VERSION = "8.22.0";
const WS_TREE_SHA256 = "82fda3fce45378d4be16230987eaf1eb07617c437c29e0e9da524209d6f55e6f";

const GATEWAY_FREEZE_ROOT = "target/private-phone-ux-validation/nested-touch-diagnostics-20261009";
const GATEWAY_MANIFEST_PATH = `${GATEWAY_FREEZE_ROOT}/gateway-c22-current-manifest.json`;
const GATEWAY_METADATA_PATH = `${GATEWAY_FREEZE_ROOT}/gateway-c22-freeze-metadata.json`;
const GATEWAY_FREEZE_SCRIPT_PATH = `${GATEWAY_FREEZE_ROOT}/freeze-gateway-c22.mjs`;
const GATEWAY_MANIFEST_SHA256 = "523a784fccc11937afadcb25e23a57be507f5d0761704cce1816ac2af9e96ffe";
const GATEWAY_METADATA_SHA256 = "4be420786a57e4fc3dc2dc53f493ed6d7d219273da6c078b83e3aa9a4b72e817";
const GATEWAY_SCRIPT_SHA256 = "6df7730aebb610ed08c9ea4492e019884a355dd8ce9ae7cb5a4251c6f2bb3dfd";
const GATEWAY_SOURCE_TREE_SHA256 = "02f803a6da08b5e6ee0915ed35da295b2cfd84548ff8c09d3ba67016233f0e24";
const GATEWAY_FILE_COUNT = 67;
const GATEWAY_RUNTIME_ROOT = "target/private-phone-ux-implementation/render-profile-gateway-runtime-c22-20261009";
const GATEWAY_DEPENDENCY_SOURCE_ROOT = "target/private-phone-ux-implementation/render-profile-gateway-runtime-3151f17f-20261008/node_modules";
const GATEWAY_RUNTIME_MANIFEST_SHA256 = "474ea99288424030dddcba6a63f47689e8dd7f24c18ca5a9e21bb78c6262c39b";
const GATEWAY_DEPENDENCY_TREE_SHA256 = "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954";
const GATEWAY_DEPENDENCY_FILE_COUNT = 1034;
const GATEWAY_RUNTIME_BINARY_PATH = "target/private-phone-ux-validation/b2-static03-build-20261008/frozen-candidate/kcoder";
const GATEWAY_RUNTIME_BINARY_SHA256 = "289618f7e0670be9840b48adcd93d73261ea1c20034596ae6a95d5ed41f3b67d";
const GATEWAY_DEV_SERVER_SHA256 = "da5fb47f82597f03ecdbdd41f6b9f3ab357b6006b6792ecc375c18e7de08c218";
const GATEWAY_HELPER_PINS = {
  "apps/kcoder-studio/e2e/harness/gateway.mjs": "7cef55697a767cb78c88dd9c4c72203e9db129e16d8502341e5496d3a325a2c9",
  "apps/kcoder-studio/e2e/harness/run-context.mjs": "94f0c27306f8944cbd10f1835227a408c51a0b558981d846832bb297c5e5cf11",
  "apps/kcoder-studio/e2e/harness/pinned-gateway.mjs": "1c3ac598e01ceb02b1dc9c3305e4fae26701a3ff3a68ad516d229517c5fba7a1",
};

const ACCESS_TTL_MS = 6_000;
const SOCKET_GRACE_MS = 3_000;
const REQUEST_TIMEOUT_MS = 20_000;
const AUTHORITY = "relay-get-pool-c22.review.test";
const RELAY_GATEWAY_ID = "c22-auth-pool";
const MAX_CAPTURED_EVENTS = 64;
const MAX_CAPTURED_HTTP_RESPONSES = 64;
const CLIENT_DIAGNOSTIC_EVENTS = Object.freeze([
  "control_connecting", "control_open", "control_error", "control_close",
  "reconnect_scheduled", "open_received", "open_rejected",
  "data_connecting", "data_open", "data_error", "data_close",
  "local_connecting", "local_connect", "local_error", "local_timeout", "local_close",
  "bridge_closed", "client_stopped",
]);

if (process.env[PRIVATE_RUN_FLAG] !== "1") {
  throw new Error(`Set ${PRIVATE_RUN_FLAG}=1 only for the reviewed private C22 lifecycle run`);
}
if (process.execPath !== EXPECTED_NODE || process.versions.node !== "22.17.0") {
  throw new Error("This private lifecycle suite requires the pinned Node 22.17.0 executable");
}

const sha256 = value => createHash("sha256").update(value).digest("hex");
const credential = () => randomBytes(32).toString("hex");

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
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
    const value = await predicate();
    if (value) return value;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function reserveLoopbackPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  assert.ok(Number.isInteger(port) && port > 0);
  return port;
}

async function observeLiveGatewaySourceProvenance() {
  const studioRoot = resolve(repoRoot, "apps/kcoder-studio");
  const manifestFile = resolve(repoRoot, GATEWAY_MANIFEST_PATH);
  const metadataFile = resolve(repoRoot, GATEWAY_METADATA_PATH);
  const scriptFile = resolve(repoRoot, GATEWAY_FREEZE_SCRIPT_PATH);
  const [manifestBytes, metadataBytes, scriptBytes] = await Promise.all([
    readFile(manifestFile), readFile(metadataFile), readFile(scriptFile),
  ]);
  assert.equal(sha256(manifestBytes), GATEWAY_MANIFEST_SHA256, "C22 Gateway manifest pin changed");
  assert.equal(sha256(scriptBytes), GATEWAY_SCRIPT_SHA256, "C22 source-freeze script pin changed");
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (GATEWAY_METADATA_SHA256) assert.equal(sha256(metadataBytes), GATEWAY_METADATA_SHA256);
  assert.equal(metadata.currentManifestSha256, GATEWAY_MANIFEST_SHA256);
  assert.equal(metadata.currentSourceTreeSha256, GATEWAY_SOURCE_TREE_SHA256);
  assert.equal(metadata.fileCount, GATEWAY_FILE_COUNT);
  assert.equal(manifest.status, "current-c22-source-closure");
  assert.equal(manifest.sourceRoot, "apps/kcoder-studio");
  assert.equal(manifest.sourceTreeSha256, GATEWAY_SOURCE_TREE_SHA256);
  assert.equal(manifest.fileCount, GATEWAY_FILE_COUNT);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === GATEWAY_FILE_COUNT);
  const pinnedEntrypoint = manifest.files.find(entry => entry.path === "dev-server.mjs");
  assert.ok(pinnedEntrypoint, "frozen C22 source manifest contains its Gateway entrypoint");
  assert.equal(pinnedEntrypoint.sha256, GATEWAY_DEV_SERVER_SHA256);

  // This is provenance only: the Gateway process below runs from the separate,
  // read-only runtime snapshot verified by verifyFrozenGatewayRuntime(). Do not
  // make live checkout drift a test input or compare it as the executed source.
  const livePath = join(studioRoot, "dev-server.mjs");
  try {
    const stat = await lstat(livePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {
        sourceRoot: "apps/kcoder-studio",
        executed: false,
        scope: "dev-server.mjs entrypoint observation only; not a live source-tree digest",
        status: "not-regular-file",
        pinnedC22Entrypoint: { size: pinnedEntrypoint.size, sha256: pinnedEntrypoint.sha256 },
      };
    }
    const canonical = await realpath(livePath);
    if (canonical !== livePath) {
      return {
        sourceRoot: "apps/kcoder-studio",
        executed: false,
        scope: "dev-server.mjs entrypoint observation only; not a live source-tree digest",
        status: "non-canonical-path",
        pinnedC22Entrypoint: { size: pinnedEntrypoint.size, sha256: pinnedEntrypoint.sha256 },
      };
    }
    const bytes = await readFile(livePath);
    const liveSha256 = sha256(bytes);
    return {
      sourceRoot: "apps/kcoder-studio",
      executed: false,
      scope: "dev-server.mjs entrypoint observation only; not a live source-tree digest",
      status: "observed",
      entrypoint: { path: "dev-server.mjs", size: bytes.length, sha256: liveSha256 },
      pinnedC22Entrypoint: { size: pinnedEntrypoint.size, sha256: pinnedEntrypoint.sha256 },
      matchesPinnedC22Entrypoint: bytes.length === pinnedEntrypoint.size && liveSha256 === pinnedEntrypoint.sha256,
    };
  } catch (error) {
    return {
      sourceRoot: "apps/kcoder-studio",
      executed: false,
      scope: "dev-server.mjs entrypoint observation only; not a live source-tree digest",
      status: "unavailable",
      errorCode: typeof error?.code === "string" ? error.code : null,
      pinnedC22Entrypoint: { size: pinnedEntrypoint.size, sha256: pinnedEntrypoint.sha256 },
    };
  }
}

async function verifyGatewayHarnessInputs() {
  const verified = {};
  for (const [path, expected] of Object.entries(GATEWAY_HELPER_PINS)) {
    const bytes = await readFile(resolve(repoRoot, path));
    const actual = sha256(bytes);
    assert.equal(actual, expected, `Gateway test harness input is pinned: ${path}`);
    verified[path] = actual;
  }
  return verified;
}

async function verifyFrozenGatewayRuntime() {
  const runtime = await validatePinnedGatewayRuntime({
    snapshotRelativePath: GATEWAY_RUNTIME_ROOT,
    expectedManifestSha256: GATEWAY_RUNTIME_MANIFEST_SHA256,
    expectedSourceTreeSha256: GATEWAY_SOURCE_TREE_SHA256,
    expectedDependencyTreeSha256: GATEWAY_DEPENDENCY_TREE_SHA256,
    expectedDevServerSha256: GATEWAY_DEV_SERVER_SHA256,
    expectedBinaryPath: GATEWAY_RUNTIME_BINARY_PATH,
    expectedBinarySha256: GATEWAY_RUNTIME_BINARY_SHA256,
    expectedNodeVersion: "v22.17.0",
  });
  const runtimeRootInfo = await lstat(runtime.root);
  assert.equal(runtimeRootInfo.mode & 0o222, 0, "frozen Gateway source runtime is read-only");
  const dependencyRoot = await realpath(join(runtime.root, "node_modules"));
  assert.equal(dependencyRoot, resolve(repoRoot, GATEWAY_DEPENDENCY_SOURCE_ROOT),
    "frozen Gateway runtime uses the previously approved pinned dependency root");
  const freeze = JSON.parse((await readFile(runtime.manifestPath)).toString("utf8"));
  assert.equal(freeze.sourceFiles.length, GATEWAY_FILE_COUNT, "frozen C22 Gateway runtime contains the exact 67-file source closure");
  assert.equal(freeze.dependencyFiles.length, GATEWAY_DEPENDENCY_FILE_COUNT,
    "frozen C22 Gateway runtime contains the exact 1,034-entry dependency closure");
  assert.equal(freeze.runtimeInputs.kcoderBinarySha256, GATEWAY_RUNTIME_BINARY_SHA256,
    "frozen runtime records the pinned CLI input, though mock mode will not spawn an app-server");
  return { ...runtime, dependencySourceRoot: GATEWAY_DEPENDENCY_SOURCE_ROOT,
    sourceFileCount: freeze.sourceFiles.length, dependencyFileCount: freeze.dependencyFiles.length };
}

async function verifyRelayFrozenSource() {
  const manifestPath = resolve(repoRoot, RELAY_MANIFEST_PATH);
  const manifestBytes = await readFile(manifestPath);
  assert.equal(sha256(manifestBytes), RELAY_MANIFEST_SHA256, "Relay static03 manifest pin changed");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.revision, "static03");
  assert.equal(manifest.designInputSha256, RELAY_DESIGN_SHA256);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === 2);
  assert.ok(Array.isArray(manifest.supportLivePins) && manifest.supportLivePins.length === 14);
  assert.ok(Array.isArray(manifest.tests) && manifest.tests.length === 1);
  const roots = {
    overlay: resolve(repoRoot, RELAY_OVERLAY_ROOT),
    baseline: resolve(repoRoot, RELAY_BASELINE_ROOT),
    supportRuntime: resolve(repoRoot, RELAY_SUPPORT_RUNTIME_ROOT),
    live: resolve(repoRoot, "apps/kcoder-relay"),
    tests: resolve(repoRoot, RELAY_TEST_ROOT),
  };
  assert.equal(await realpath(roots.supportRuntime), roots.supportRuntime,
    "Relay support source root is the canonical current tree used only after exact manifest-pin verification");
  const supportRuntimeInfo = await lstat(roots.supportRuntime);
  assert.equal(supportRuntimeInfo.isDirectory(), true);
  assert.equal(supportRuntimeInfo.isSymbolicLink(), false);
  const overlay = {};
  const baseline = {};
  const support = {};
  const liveSupportProvenance = {};
  const tests = {};
  const checked = new Set();
  const checkFile = async (root, rel, expected, target, key = rel) => {
    assert.ok(!rel.startsWith("/") && !rel.split(/[\\/]/).includes(".."));
    assert.equal(checked.has(`${root}\0${rel}`), false, `Relay manifest path is unique: ${rel}`);
    checked.add(`${root}\0${rel}`);
    const path = join(root, rel);
    const stat = await lstat(path);
    assert.equal(stat.isSymbolicLink(), false, `Relay input is not a symlink: ${rel}`);
    assert.equal(stat.isFile(), true, `Relay input is a regular file: ${rel}`);
    const actual = sha256(await readFile(path));
    assert.equal(actual, expected, `Relay frozen input changed: ${rel}`);
    target[key] = actual;
  };
  for (const entry of manifest.files) {
    await checkFile(roots.overlay, entry.path, entry.after, overlay);
    if (entry.before !== null) await checkFile(roots.baseline, entry.path, entry.before, baseline);
  }
  for (const entry of manifest.supportLivePins) {
    const relativePath = entry.path.replace(/^apps\/kcoder-relay\//, "");
    await checkFile(roots.supportRuntime, relativePath, entry.sha256, support, entry.path);
    const livePath = join(roots.live, relativePath);
    try {
      const liveInfo = await lstat(livePath);
      if (!liveInfo.isFile() || liveInfo.isSymbolicLink()) {
        liveSupportProvenance[entry.path] = { status: "not-regular-file", executed: false };
        continue;
      }
      if (await realpath(livePath) !== livePath) {
        liveSupportProvenance[entry.path] = { status: "non-canonical-path", executed: false };
        continue;
      }
      const bytes = await readFile(livePath);
      const actualSha256 = sha256(bytes);
      liveSupportProvenance[entry.path] = {
        status: "observed",
        executed: false,
        size: bytes.length,
        sha256: actualSha256,
        matchesStatic03SupportPin: bytes.length === entry.size && actualSha256 === entry.sha256,
      };
    } catch (error) {
      liveSupportProvenance[entry.path] = {
        status: "unavailable",
        executed: false,
        errorCode: typeof error?.code === "string" ? error.code : null,
      };
    }
  }
  for (const entry of manifest.tests) {
    await checkFile(roots.tests, entry.path, entry.sha256, tests);
  }
  assert.equal(overlay["apps/kcoder-relay/src/server.mjs"], RELAY_SERVER_SHA256);
  assert.equal(overlay["apps/kcoder-relay/src/http-get-pool.mjs"], RELAY_POOL_SHA256);
  assert.ok(support["apps/kcoder-relay/src/client.mjs"]);
  assert.ok(support["apps/kcoder-relay/src/transport.mjs"]);
  assert.ok(support["apps/kcoder-relay/package.json"]);
  assert.ok(support["apps/kcoder-relay/package-lock.json"]);

  assert.equal(liveSupportProvenance["apps/kcoder-relay/package.json"].matchesStatic03SupportPin, true,
    "live Relay package metadata still matches the frozen support source");
  assert.equal(liveSupportProvenance["apps/kcoder-relay/package-lock.json"].matchesStatic03SupportPin, true,
    "live Relay lockfile still matches the frozen support source used to pin ws");
  const packageLock = JSON.parse((await readFile(join(roots.supportRuntime, "package-lock.json"))).toString("utf8"));
  assert.equal(packageLock.packages?.["node_modules/ws"]?.version, WS_VERSION);
  const wsTree = await verifyWsTree(join(roots.live, "node_modules/ws"));
  return { ...roots, manifestPath, manifestSha256: sha256(manifestBytes), overlay, baseline, support,
    liveSupportProvenance, tests, wsTree };
}

async function verifyWsTree(root) {
  const rootStat = await lstat(root);
  assert.equal(rootStat.isDirectory(), true);
  assert.equal(rootStat.isSymbolicLink(), false);
  const rows = [];
  let bytesTotal = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      assert.equal(stat.isSymbolicLink(), false, "pinned ws dependency contains no symlinks");
      if (stat.isDirectory()) await walk(path);
      else {
        assert.equal(stat.isFile(), true);
        const bytes = await readFile(path);
        bytesTotal += bytes.length;
        assert.ok(rows.length < 64 && bytesTotal <= 1024 * 1024, "ws dependency hash walk stays bounded");
        rows.push({ path: relative(root, path).split("\\").join("/"), sha256: sha256(bytes) });
      }
    }
  }
  await walk(root);
  rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const digest = createHash("sha256");
  for (const row of rows) digest.update(`${row.path}\0${row.sha256}\n`);
  const packageInfo = JSON.parse((await readFile(join(root, "package.json"))).toString("utf8"));
  assert.equal(packageInfo.version, WS_VERSION);
  assert.equal(digest.digest("hex"), WS_TREE_SHA256);
  return { version: packageInfo.version, fileCount: rows.length, bytes: bytesTotal, treeSha256: WS_TREE_SHA256 };
}

async function makeRelayRuntime(context, frozen) {
  const runtimeRoot = context.pathInState("relay-runtime");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  for (const sourcePath of Object.keys(frozen.support)) {
    const pathInPackage = sourcePath.replace(/^apps\/kcoder-relay\//, "");
    const destination = join(runtimeRoot, pathInPackage);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(join(frozen.supportRuntime, pathInPackage), destination, { errorOnExist: true });
  }
  for (const sourcePath of Object.keys(frozen.overlay)) {
    const destinationPath = sourcePath.replace(/^apps\/kcoder-relay\//, "");
    const destination = join(runtimeRoot, destinationPath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(join(resolve(repoRoot, RELAY_OVERLAY_ROOT), sourcePath), destination, { force: true });
  }
  const wsTarget = join(runtimeRoot, "node_modules/ws");
  await mkdir(dirname(wsTarget), { recursive: true, mode: 0o700 });
  await cp(join(frozen.live, "node_modules/ws"), wsTarget, { recursive: true, errorOnExist: true });
  return runtimeRoot;
}

async function verifyRelayRuntime(runtimeRoot, frozen) {
  const copied = {};
  for (const [sourcePath, expected] of Object.entries(frozen.support)) {
    const pathInPackage = sourcePath.replace(/^apps\/kcoder-relay\//, "");
    if (pathInPackage === "src/server.mjs") continue;
    const actual = sha256(await readFile(join(runtimeRoot, pathInPackage)));
    assert.equal(actual, expected, `owned Relay support copy matches: ${sourcePath}`);
    copied[sourcePath] = actual;
  }
  for (const [sourcePath, expected] of Object.entries(frozen.overlay)) {
    const pathInPackage = sourcePath.replace(/^apps\/kcoder-relay\//, "");
    const actual = sha256(await readFile(join(runtimeRoot, pathInPackage)));
    assert.equal(actual, expected, `owned Relay overlay copy matches: ${sourcePath}`);
    copied[sourcePath] = actual;
  }
  const wsTree = await verifyWsTree(join(runtimeRoot, "node_modules/ws"));
  assert.deepEqual(wsTree, frozen.wsTree, "owned ws runtime copy matches the pinned installed dependency");
  return copied;
}

function responseHoldPreloadSource() {
  return `import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServerResponse } from 'node:http';
const root = process.env.KCODER_E2E_AUTH_RESPONSE_GATE_DIR;
if (root) {
  writeFileSync(join(root, 'hook-loaded.json'), JSON.stringify({ ready: true, at: Date.now() }), { flag: 'wx', mode: 0o600 });
  const originalEnd = ServerResponse.prototype.end;
  const heldResponses = new WeakSet();
  ServerResponse.prototype.end = function (...args) {
    const request = this.req;
    const id = request?.headers?.['x-kcoder-e2e-response-hold'];
    if (heldResponses.has(this) || request?.method !== 'GET' || request?.url !== '/api/servers' ||
        this.statusCode !== 200 || typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) {
      return originalEnd.apply(this, args);
    }
    const allowPath = join(root, id + '.allow');
    if (!existsSync(allowPath)) return originalEnd.apply(this, args);
    unlinkSync(allowPath);
    heldResponses.add(this);
    const event = JSON.stringify({ event: 'gateway-response-held', method: 'GET', path: '/api/servers', status: this.statusCode, at: Date.now() }) + '\\n';
    writeFileSync(join(root, id + '.entered.json'), event, { flag: 'wx', mode: 0o600 });
    let done = false;
    let poll = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (poll) clearInterval(poll);
      this.removeListener('close', onClose);
      if (!this.destroyed) originalEnd.apply(this, args);
    };
    const onClose = () => {
      if (done) return;
      done = true;
      if (poll) clearInterval(poll);
      writeFileSync(join(root, id + '.cancelled.json'), JSON.stringify({ event: 'gateway-response-cancelled', at: Date.now() }) + '\\n', { flag: 'wx', mode: 0o600 });
    };
    this.once('close', onClose);
    poll = setInterval(() => {
      if (this.destroyed) onClose();
      else if (existsSync(join(root, id + '.release'))) finish();
    }, 5);
    poll.unref?.();
    return this;
  };
}
`;
}

function makeSafeClient(context, relay, gateway, secret, records) {
  const ready = deferred();
  let readyOnce = false;
  const eventState = {
    observedCount: 0,
    droppedCount: 0,
    unknownEventCount: 0,
    counts: Object.fromEntries(CLIENT_DIAGNOSTIC_EVENTS.map(event => [event, 0])),
    lastControlEvent: null,
  };
  const client = relay.clientModule.startClient({
    url: `http://127.0.0.1:${relay.controlPort}`,
    secret,
    gatewayId: RELAY_GATEWAY_ID,
    gateway: gateway.baseUrl,
    allowInsecure: true,
    retryMs: 50,
    onOnline() {
      if (!readyOnce) { readyOnce = true; ready.resolve(); }
    },
    onDiagnostic(record) {
      eventState.observedCount += 1;
      const eventName = CLIENT_DIAGNOSTIC_EVENTS.includes(record.event) ? record.event : null;
      const event = {
        event: eventName || "unknown",
        generation: Number.isSafeInteger(record.generation) ? record.generation : null,
        atUnixMs: Number.isSafeInteger(record.atUnixMs) ? record.atUnixMs : null,
        ...(Number.isInteger(record.closeCode) ? { closeCode: record.closeCode } : {}),
        ...(typeof record.errorKind === "string" ? { errorKind: record.errorKind } : {}),
      };
      if (eventName) eventState.counts[eventName] += 1;
      else eventState.unknownEventCount += 1;
      if (eventName?.startsWith("control_")) eventState.lastControlEvent = event;
      if (records.length >= MAX_CAPTURED_EVENTS) {
        eventState.droppedCount += 1;
        return;
      }
      records.push(event);
    },
  });
  context.addCleanup("stop owned Relay control client", async () => {
    client.close();
  });
  return { client, ready: ready.promise, records, eventState };
}

function summarizeClientEvents(records) {
  return records.map((record, index) => ({
    clientOrdinal: index + 1,
    observedCount: record.eventState.observedCount,
    droppedCount: record.eventState.droppedCount,
    unknownEventCount: record.eventState.unknownEventCount,
    counts: { ...record.eventState.counts },
    lastControlEvent: record.eventState.lastControlEvent ? { ...record.eventState.lastControlEvent } : null,
  }));
}

async function installControlOnlyDisconnect(relayRuntimeRoot, controlPort) {
  const wsModule = await import(pathToFileURL(join(relayRuntimeRoot, "node_modules/ws/index.js")).href);
  const WebSocket = wsModule.default;
  assert.equal(typeof WebSocket?.prototype?.terminate, "function", "pinned ws client exposes terminate");
  const prototype = WebSocket.prototype;
  const originalTerminate = prototype.terminate;
  const counts = { controlTerminateCalls: 0, dataTerminateSuppressed: 0 };
  const wrappedTerminate = function (...args) {
    let target;
    try { target = new URL(this.url); } catch {}
    if (target?.origin === `ws://127.0.0.1:${controlPort}`) {
      if (target.pathname === "/_relay/data") {
        counts.dataTerminateSuppressed += 1;
        return this;
      }
      if (target.pathname === "/_relay/control") counts.controlTerminateCalls += 1;
    }
    return originalTerminate.apply(this, args);
  };
  prototype.terminate = wrappedTerminate;
  let restored = false;
  return {
    snapshot: () => ({ ...counts }),
    restore() {
      if (restored) return;
      restored = true;
      if (prototype.terminate === wrappedTerminate) prototype.terminate = originalTerminate;
    },
  };
}

function beginRelayRequest(context, relay, { path, method = "GET", accessToken, body, holdId, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const bodyBytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = { host: relay.publicAuthority || AUTHORITY, connection: "close" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (holdId) headers["x-kcoder-e2e-response-hold"] = holdId;
  if (bodyBytes) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(bodyBytes.length);
  }
  let settled = false;
  let incoming = null;
  const chunks = [];
  const sent = deferred();
  const result = deferred();
  const settle = value => {
    if (settled) return;
    settled = true;
    result.resolve(value);
  };
  const request = httpRequest({
    host: "127.0.0.1",
    port: relay.proxyPort,
    method,
    path: `/g/${RELAY_GATEWAY_ID}${path}`,
    headers,
  }, response => {
    incoming = response;
    response.on("data", chunk => {
      if (chunks.reduce((sum, item) => sum + item.length, 0) + chunk.length <= 256 * 1024) chunks.push(Buffer.from(chunk));
      else request.destroy(Object.assign(new Error("response too large"), { code: "REVIEW_RESPONSE_TOO_LARGE" }));
    });
    response.once("end", () => settle({ outcome: "complete", status: response.statusCode || 0,
      headers: response.headers, body: Buffer.concat(chunks) }));
    response.once("aborted", () => settle({ outcome: "aborted", status: response.statusCode || 0 }));
    response.once("error", error => settle({ outcome: "response-error", status: response.statusCode || 0,
      errorCode: typeof error?.code === "string" ? error.code : "unknown" }));
  });
  request.once("finish", () => { sent.resolve(); bodyBytes?.fill(0); });
  request.once("error", error => settle({ outcome: error?.code === "ECONNRESET" ? "reset" : "request-error",
    status: incoming?.statusCode || 0, errorCode: typeof error?.code === "string" ? error.code : "unknown" }));
  request.once("close", () => bodyBytes?.fill(0));
  request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error("request timeout"), { code: "ETIMEDOUT" })));
  request.end(bodyBytes || undefined);
  const completion = result.promise;
  context.pendingReviewRequests ??= new Set();
  context.pendingReviewRequests.add(completion);
  void completion.finally(() => context.pendingReviewRequests.delete(completion));
  return { result: completion, sent: sent.promise, abort: () => request.destroy(), get settled() { return settled; } };
}

function safeHttpRoute(path) {
  if (path === "/api/mobile/session") return "mobile-session";
  if (path === "/api/mobile/session/refresh") return "mobile-session-refresh";
  if (path === "/api/servers") return "servers";
  if (/^\/api\/mobile\/devices\/[A-Za-z0-9-]{16,128}$/.test(path)) return "mobile-device/:id";
  return "other";
}

function recordSafeHttpResponse(context, response, path, method = "GET") {
  const rows = context.gatewayHttpResponseDiagnostics ??= [];
  if (rows.length >= MAX_CAPTURED_HTTP_RESPONSES) return;
  const rawContentType = response.headers?.["content-type"];
  const mediaType = typeof rawContentType === "string"
    ? rawContentType.split(";", 1)[0].trim().toLowerCase()
    : "";
  const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
    ? mediaType
    : null;
  rows.push({
    route: safeHttpRoute(path),
    method: ["GET", "POST", "PUT", "DELETE"].includes(method) ? method : "OTHER",
    outcome: typeof response.outcome === "string" ? response.outcome : "unknown",
    status: Number.isInteger(response.status) ? response.status : null,
    contentType,
    bodyBytes: Buffer.isBuffer(response.body) ? response.body.length : 0,
  });
}

async function relayJson(context, relay, options) {
  const { path, method = "GET" } = options;
  const response = await beginRelayRequest(context, relay, options).result;
  recordSafeHttpResponse(context, response, path, method);
  assert.equal(response.outcome, "complete", "owned Relay HTTP request completes");
  if (response.status === 204) {
    response.body.fill(0);
    return { ...response, payload: null };
  }
  let payload;
  try { payload = JSON.parse(response.body.toString("utf8")); }
  catch { response.body.fill(0); throw new Error("Gateway HTTP response is not valid JSON"); }
  return { ...response, payload };
}

function registerGrantSecrets(context, grant) {
  for (const name of ["accessToken", "refreshToken", "rpcToken"]) {
    if (typeof grant?.[name] === "string") context.registerSecret(grant[name]);
  }
}

async function pairDevice(context, relay, gateway, deviceLabel) {
  const response = await relayJson(context, relay, {
    path: "/api/mobile/session",
    method: "POST",
    body: { token: gateway.authToken, durableDeviceAuthorization: true, deviceLabel },
  });
  assert.equal(response.status, 200, "real C22 Gateway accepts the durable device pairing");
  assert.equal(response.headers["set-cookie"], undefined, "durable device pairing does not create a cookie");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.payload.capabilities?.mobileRefreshV1, true);
  assert.equal(response.payload.capabilities?.mobileDeviceManagementV1, true);
  assert.ok(Number.isSafeInteger(response.payload.expiresAt) && response.payload.expiresAt > Date.now());
  assert.ok(Number.isSafeInteger(response.payload.wsLeaseExpiresAt) && response.payload.wsLeaseExpiresAt > response.payload.expiresAt);
  registerGrantSecrets(context, response.payload);
  response.body.fill(0);
  return response.payload;
}

async function refreshDevice(context, relay, grant, label) {
  const response = await relayJson(context, relay, {
    path: "/api/mobile/session/refresh",
    method: "POST",
    body: { refreshToken: grant.refreshToken, rotationId: `${label}-${randomUUID()}`, deviceId: grant.deviceId },
  });
  assert.equal(response.status, 200, "real C22 Gateway accepts the durable refresh credential");
  assert.equal(response.payload.deviceId, grant.deviceId, "refresh remains in the same device family");
  assert.equal(response.payload.authorizationGeneration, grant.authorizationGeneration,
    "routine token rotation preserves the device authorization generation");
  assert.notEqual(response.payload.accessToken, grant.accessToken);
  assert.notEqual(response.payload.refreshToken, grant.refreshToken);
  registerGrantSecrets(context, response.payload);
  response.body.fill(0);
  return response.payload;
}

async function getStatus(context, relay, accessToken) {
  const result = await beginRelayRequest(context, relay, {
    path: "/api/servers",
    accessToken,
  }).result;
  assert.equal(result.outcome, "complete", "authenticated server-list GET completes over Relay HTTP");
  let payload = null;
  if (result.status === 200) {
    try { payload = JSON.parse(result.body.toString("utf8")); }
    catch { result.body.fill(0); throw new Error("Gateway server-list response is not valid JSON"); }
  }
  result.body.fill(0);
  return { status: result.status, payload, headers: result.headers };
}

let queueWaiter = null;
let poolAcquireWaiter = null;
let retirementWaiter = null;
let observedPoolAcquireEvents = [];
let observedQueueEvents = [];
let observedRetireEvents = [];

function installPoolObservers(poolModule) {
  const prototype = poolModule.GrantGetPool.prototype;
  const originalAcquire = prototype.acquire;
  const originalRetire = prototype.retire;
  const poolOrdinals = new WeakMap();
  let nextPoolOrdinal = 1;
  const ordinalFor = pool => {
    let ordinal = poolOrdinals.get(pool);
    if (ordinal === undefined) {
      ordinal = nextPoolOrdinal++;
      poolOrdinals.set(pool, ordinal);
    }
    return ordinal;
  };
  prototype.acquire = function (signal) {
    const poolOrdinal = ordinalFor(this);
    const priorDepth = this.queue.length;
    const result = originalAcquire.call(this, signal);
    const acquireEvent = { poolOrdinal, queueDepthBefore: priorDepth, atUnixMs: Date.now() };
    if (observedPoolAcquireEvents.length < MAX_CAPTURED_EVENTS) observedPoolAcquireEvents.push(acquireEvent);
    if (poolAcquireWaiter) {
      const waiter = poolAcquireWaiter;
      poolAcquireWaiter = null;
      waiter.resolve(acquireEvent);
    }
    if (this.queue.length > priorDepth) {
      const event = { poolOrdinal, queueDepth: this.queue.length, atUnixMs: Date.now() };
      if (observedQueueEvents.length < MAX_CAPTURED_EVENTS) observedQueueEvents.push(event);
      if (queueWaiter) {
        const waiter = queueWaiter;
        queueWaiter = null;
        waiter.resolve(event);
      }
    }
    return result;
  };
  prototype.retire = function (error, hard = false) {
    const event = {
      poolOrdinal: ordinalFor(this),
      code: ["RELAY_UNAUTHORIZED", "RELAY_UNAVAILABLE", "RELAY_TIMEOUT"].includes(error?.code) ? error.code : "other",
      hard: Boolean(hard),
      activeSlots: this.slots.filter(slot => slot.active).length,
      forwardedSlots: this.slots.filter(slot => slot.active && slot.forwarded).length,
      queued: this.queue.length,
      atUnixMs: Date.now(),
    };
    if (observedRetireEvents.length < MAX_CAPTURED_EVENTS) observedRetireEvents.push(event);
    if (retirementWaiter && retirementWaiter.code === event.code && retirementWaiter.hard === event.hard &&
        retirementWaiter.poolOrdinal === event.poolOrdinal) {
      const waiter = retirementWaiter;
      retirementWaiter = null;
      waiter.resolve(event);
    }
    return originalRetire.call(this, error, hard);
  };
  return () => {
    prototype.acquire = originalAcquire;
    prototype.retire = originalRetire;
    queueWaiter = null;
    poolAcquireWaiter = null;
    retirementWaiter = null;
  };
}

function expectQueueInsertion() {
  assert.equal(queueWaiter, null, "only one queue insertion barrier is active");
  const signal = deferred();
  queueWaiter = signal;
  return signal.promise;
}

function expectPoolAcquisition() {
  assert.equal(poolAcquireWaiter, null, "only one pool acquisition barrier is active");
  const signal = deferred();
  poolAcquireWaiter = signal;
  return signal.promise;
}

function expectRetirement(code, hard, poolOrdinal) {
  assert.ok(Number.isSafeInteger(poolOrdinal) && poolOrdinal > 0, "retirement waiter is bound to one observed pool");
  assert.equal(retirementWaiter, null, "only one pool retirement barrier is active");
  const signal = deferred();
  retirementWaiter = { code, hard, poolOrdinal, resolve: signal.resolve };
  return signal.promise;
}

function readGatePath(gateDir, gateId, suffix) {
  return join(gateDir, `${gateId}.${suffix}.json`);
}

async function createHoldGate(gateDir, label, gateIds) {
  const id = randomUUID();
  gateIds.add(id);
  await writeFile(join(gateDir, `${id}.allow`), "hold\n", { flag: "wx", mode: 0o600 });
  return { id, label };
}

async function waitForGate(gateDir, gate, suffix, timeoutMs = 5_000) {
  const path = readGatePath(gateDir, gate.id, suffix);
  const bytes = await waitUntil(() => existsSync(path) ? readFile(path) : null, timeoutMs,
    `Gateway response gate ${suffix}`);
  return JSON.parse(bytes.toString("utf8"));
}

async function releaseGate(gateDir, gate) {
  const path = join(gateDir, `${gate.id}.release`);
  if (!existsSync(path)) await writeFile(path, "release\n", { flag: "wx", mode: 0o600 });
}

async function releaseAllGates(gateDir, gateIds) {
  for (const id of gateIds) {
    const path = join(gateDir, `${id}.release`);
    if (!existsSync(path)) await writeFile(path, "cleanup\n", { flag: "wx", mode: 0o600 }).catch(error => {
      if (error?.code !== "EEXIST") throw error;
    });
  }
}

function startHeldGet(context, relay, grant, gate) {
  return beginRelayRequest(context, relay, {
    path: "/api/servers",
    accessToken: grant.accessToken,
    holdId: gate.id,
  });
}

function assertHeldResponse(result, label) {
  assert.equal(result.outcome, "complete", `${label} reaches a complete HTTP response`);
  assert.equal(result.status, 200, `${label} forwarded response completes with HTTP 200`);
  result.body.fill(0);
}

function assertClosedResponse(result, label) {
  assert.ok(result.outcome === "aborted" || result.outcome === "reset" || result.outcome === "response-error" ||
    (result.outcome === "complete" && result.status === 503),
  `${label} is closed by hard authorization/control revocation without a successful response`);
  assert.notEqual(result.status, 200, `${label} cannot receive the held success after hard close`);
  result.body?.fill(0);
}

await runE2E(
  import.meta.url,
  {
    testId: "private-relay-get-pool-static03-c22-gateway-auth-lifecycle",
    tier: "private-integration",
    modelPolicy: "pinned read-only C22 Gateway runtime snapshot plus static03 Relay overlay and 14 manifest-pinned current hosting source/package files copied into an owned runtime; the live tree is only a hash-verified copy source, and ws dependency bytes are separately pinned; test-only held /api/servers response, no app-server, Provider, browser, public Relay, or production session",
    retainSuccessLogs: true,
    cleanupTimeoutMs: 15_000,
    bodyAbortTimeoutMs: 5_000,
  },
  async context => {
    const evidence = {
      scope: "pinned read-only C22 Gateway runtime snapshot durable pair/refresh/access expiry/device revoke over a static03 Relay overlay and 14 current hosting source/package files copied after exact manifest-pin checks into an owned runtime; control-channel generation replacement; live Gateway and Relay source are not executed directly; no app-server or Provider execution",
      runtime: { node: process.version, nodePath: process.execPath },
      gatewayLiveSourceProvenanceBefore: null,
      gatewayLiveSourceProvenanceAfter: null,
      relayLiveSourceProvenanceBefore: null,
      relayLiveSourceProvenanceAfter: null,
      relayExecutedSupportSource: null,
      gatewayRuntimeBefore: null,
      gatewayRuntimeAfter: null,
      gatewayHarnessInputsBefore: null,
      gatewayHarnessInputsAfter: null,
      relayManifestSha256: null,
      relayOverlayCopies: null,
      wsRuntime: null,
      gatewayResponseGate: { loaded: false, captured: 0, cancelled: 0, completed: 0 },
      gatewayHttpResponses: [],
      controlOnlyDisconnect: null,
      poolAcquireObservations: [],
      queueObservations: [],
      retirementObservations: [],
      clientEvents: [],
      cases: [],
      result: "running",
    };
    let failure = null;
    let restorePoolObservers = null;
    let relay = null;
    let frozenRelay = null;
    let relayRuntimeRoot = null;
    let gateway = null;
    let activeClientRecords = [];
    let gatewayLiveSourceProvenanceBefore = null;
    let gatewayRuntimeBefore = null;
    let gatewayHarnessInputsBefore = null;
    const gateIds = new Set();
    try {
      gatewayHarnessInputsBefore = await verifyGatewayHarnessInputs();
      evidence.gatewayHarnessInputsBefore = gatewayHarnessInputsBefore;
      gatewayRuntimeBefore = await verifyFrozenGatewayRuntime();
      evidence.gatewayRuntimeBefore = gatewayRuntimeBefore;
      gatewayLiveSourceProvenanceBefore = await observeLiveGatewaySourceProvenance();
      evidence.gatewayLiveSourceProvenanceBefore = gatewayLiveSourceProvenanceBefore;
      evidence.gatewayExecutionInput = {
        sourceRoot: gatewayRuntimeBefore.root,
        scriptPath: gatewayRuntimeBefore.scriptPath,
        sourceTreeSha256: gatewayRuntimeBefore.sourceTreeSha256,
        manifestPath: gatewayRuntimeBefore.manifestPath,
        manifestSha256: gatewayRuntimeBefore.manifestSha256,
        dependencyTreeSha256: gatewayRuntimeBefore.dependencyTreeSha256,
        binaryPath: gatewayRuntimeBefore.binaryPath,
        binarySha256: gatewayRuntimeBefore.binarySha256,
      };
      frozenRelay = await verifyRelayFrozenSource();
      evidence.relayManifestSha256 = frozenRelay.manifestSha256;
      evidence.wsRuntime = frozenRelay.wsTree;
      evidence.relayLiveSourceProvenanceBefore = frozenRelay.liveSupportProvenance;
      evidence.relayExecutedSupportSource = {
        root: frozenRelay.supportRuntime,
        supportPins: frozenRelay.support,
        static03OverlayPins: frozenRelay.overlay,
      };
      relayRuntimeRoot = await makeRelayRuntime(context, frozenRelay);
      evidence.relayOverlayCopies = await verifyRelayRuntime(relayRuntimeRoot, frozenRelay);

      // Instrument only the in-memory queue/retirement observation points; each
      // wrapper calls the exact frozen implementation once and returns its value.
      const poolUrl = pathToFileURL(join(relayRuntimeRoot, "src/http-get-pool.mjs")).href;
      const poolModule = await import(poolUrl);
      restorePoolObservers = installPoolObservers(poolModule);
      const relayModule = await import(pathToFileURL(join(relayRuntimeRoot, "src/server.mjs")).href);
      const clientModule = await import(pathToFileURL(join(relayRuntimeRoot, "src/client.mjs")).href);
      relay = { module: relayModule, clientModule, proxyPort: 0, controlPort: 0 };

      const stateRoot = context.pathInState("gateway-fixture");
      const workspace = join(stateRoot, "workspace");
      const configDir = join(stateRoot, "config");
      const webRoot = join(stateRoot, "web-root");
      const gateDir = join(stateRoot, "response-gates");
      await Promise.all([
        mkdir(workspace, { recursive: true, mode: 0o700 }),
        mkdir(configDir, { recursive: true, mode: 0o700 }),
        mkdir(webRoot, { recursive: true, mode: 0o700 }),
        mkdir(gateDir, { recursive: true, mode: 0o700 }),
      ]);
      await writeFile(join(webRoot, "index.html"), "<!doctype html><title>private Gateway HTTP fixture</title>\n", { flag: "wx", mode: 0o600 });
      const serversStore = join(configDir, "servers.json");
      await writeFile(serversStore, JSON.stringify([{
        id: "local",
        label: "C22 Relay GET pool HTTP fixture",
        runtime: "kcoder",
        transport: "local",
        workspace,
      }]), { flag: "wx", mode: 0o600 });
      const preloadPath = context.pathInState("gateway-response-hold-preload.mjs");
      await writeFile(preloadPath, responseHoldPreloadSource(), { flag: "wx", mode: 0o600 });

      const proxyPort = await reserveLoopbackPort();
      const publicAuthority = `${AUTHORITY}:${proxyPort}`;
      const relaySecret = credential();
      context.registerSecret(relaySecret);
      gateway = await startGateway(context, {
        label: "c22-relay-get-pool-gateway",
        auth: true,
        gatewayRoot: gatewayRuntimeBefore.root,
        cwd: gatewayRuntimeBefore.root,
        workspace,
        serversStore,
        kcoderBin: gatewayRuntimeBefore.binaryPath,
        env: {
          KCODER_CONFIG_DIR: configDir,
          KCODER_STUDIO_MOCK: "1",
          KCODER_STUDIO_WEB_ROOT: webRoot,
          KCODER_STUDIO_PUBLIC_ORIGINS: `http://${publicAuthority}`,
          KCODER_STUDIO_AUTH_SESSION_TTL_MS: "3600000",
          KCODER_STUDIO_MOBILE_ACCESS_TTL_MS: String(ACCESS_TTL_MS),
          KCODER_STUDIO_MOBILE_SOCKET_GRACE_MS: String(SOCKET_GRACE_MS),
          KCODER_E2E_AUTH_RESPONSE_GATE_DIR: gateDir,
          NODE_OPTIONS: `--import=${preloadPath}`,
        },
      });
      context.registerSecret(gateway.authToken);

      relay = await relayModule.startRelay({
        gateways: [{
          id: RELAY_GATEWAY_ID,
          secret: relaySecret,
          pairingToken: gateway.authToken,
          baseUrl: gateway.baseUrl,
          maxConnections: 8,
        }],
        sharedHosts: [publicAuthority],
        controlPort: 0,
        proxyPort,
        maxConnections: 8,
        maxBytesPerWindow: 16 * 1024 * 1024,
        connectTimeout: 10_000,
        pairingBodyTimeoutMs: 5_000,
      });
      relay.publicAuthority = publicAuthority;
      context.registerPort("c22-relay-get-pool-control", relay.controlPort);
      context.registerPort("c22-relay-get-pool-proxy", relay.proxyPort);
      context.addCleanup("close owned Relay static03 runtime", () => relay.close());
      await waitUntil(() => existsSync(join(gateDir, "hook-loaded.json")) ? true : null, 2_000,
        "Gateway test-only response observer preload");
      evidence.gatewayResponseGate.loaded = true;

      const clientSecret = relaySecret;
      const createClient = () => {
        const events = [];
        const record = makeSafeClient(context, { ...relay, clientModule }, gateway, clientSecret, events);
        activeClientRecords.push(record);
        return record;
      };
      let relayClient = createClient();
      await within(relayClient.ready, 8_000, "initial Relay control connection");

      const holdGate = async (grant, label) => {
        const gate = await createHoldGate(gateDir, label, gateIds);
        const request = startHeldGet(context, relay, grant, gate);
        await request.sent;
        const entered = await waitForGate(gateDir, gate, "entered", 5_000);
        assert.equal(entered.status, 200, `${label} is held only after real Gateway authorization and handler completion`);
        evidence.gatewayResponseGate.captured += 1;
        return { gate, request };
      };

      // Routine access rotation: two fully forwarded Gateway responses remain
      // drainable while a third old-grant request is queued and rejected.
      const grantA = await pairDevice(context, relay, gateway, "refresh-target");
      const a1 = await holdGate(grantA, "refresh-a1");
      const a2 = await holdGate(grantA, "refresh-a2");
      const refreshQueue = expectQueueInsertion();
      const queuedA = beginRelayRequest(context, relay, {
        path: "/api/servers", accessToken: grantA.accessToken,
        holdId: (await createHoldGate(gateDir, "refresh-queued", gateIds)).id,
      });
      await queuedA.sent;
      const queuedAObserved = await within(refreshQueue, 3_000, "old-grant refresh case queue insertion");
      assert.equal(queuedAObserved.queueDepth, 1);
      const refreshRetirement = expectRetirement("RELAY_UNAUTHORIZED", false, queuedAObserved.poolOrdinal);
      const refreshedA = await refreshDevice(context, relay, grantA, "refresh-a");
      const refreshRetired = await within(refreshRetirement, 3_000, "routine refresh soft-retires the old GET pool");
      assert.deepEqual({ code: refreshRetired.code, hard: refreshRetired.hard, activeSlots: refreshRetired.activeSlots,
        forwardedSlots: refreshRetired.forwardedSlots, queued: refreshRetired.queued },
      { code: "RELAY_UNAUTHORIZED", hard: false, activeSlots: 2, forwardedSlots: 2, queued: 1 });
      const queuedAResult = await within(queuedA.result, 3_000, "queued old grant rejected after refresh");
      assert.equal(queuedAResult.outcome, "complete");
      assert.equal(queuedAResult.status, 401);
      await Promise.all([releaseGate(gateDir, a1.gate), releaseGate(gateDir, a2.gate)]);
      const refreshedDrain = await Promise.all([a1.request.result, a2.request.result]);
      assertHeldResponse(refreshedDrain[0], "first forwarded old-grant response after refresh");
      assertHeldResponse(refreshedDrain[1], "second forwarded old-grant response after refresh");
      assert.equal((await getStatus(context, relay, grantA.accessToken)).status, 401, "old access cannot start a fresh request after rotation");
      assert.equal((await getStatus(context, relay, refreshedA.accessToken)).status, 200, "rotated access starts a new authenticated GET pool");
      evidence.cases.push({
        id: "refresh-pending-versus-forwarded-drain",
        outcome: "PASS",
        queuedOldGrantStatus: queuedAResult.status,
        forwardedOldGrantStatuses: refreshedDrain.map(item => item.status),
        oldAccessStatus: 401,
        newAccessStatus: 200,
        poolRetirement: refreshRetired,
      });

      // Natural access expiry is checked against the server-issued absolute
      // expiresAt. It retires/rejects queued work but lets already-forwarded
      // requests settle once within their bounded family socket grace.
      const expiring = await pairDevice(context, relay, gateway, "natural-expiry");
      const expiryA = await holdGate(expiring, "expiry-a1");
      const expiryB = await holdGate(expiring, "expiry-a2");
      const expiryQueue = expectQueueInsertion();
      const queuedExpiryGate = await createHoldGate(gateDir, "expiry-queued", gateIds);
      const queuedExpiry = beginRelayRequest(context, relay, {
        path: "/api/servers", accessToken: expiring.accessToken, holdId: queuedExpiryGate.id,
      });
      await queuedExpiry.sent;
      const queuedExpiryObserved = await within(expiryQueue, 3_000, "natural-expiry queue insertion");
      assert.equal(queuedExpiryObserved.queueDepth, 1);
      assert.ok(expiring.wsLeaseExpiresAt > expiring.expiresAt, "fixture has a bounded post-access family lease");
      const expiryRetirement = expectRetirement("RELAY_UNAUTHORIZED", false, queuedExpiryObserved.poolOrdinal);
      await waitUntil(() => Date.now() >= expiring.expiresAt + 100 ? true : null, ACCESS_TTL_MS + 3_000,
        "server-issued access expiry");
      const expiryRetired = await within(expiryRetirement, 2_000, "pool retirement at natural access expiry");
      assert.deepEqual({ code: expiryRetired.code, hard: expiryRetired.hard, activeSlots: expiryRetired.activeSlots,
        forwardedSlots: expiryRetired.forwardedSlots, queued: expiryRetired.queued },
      { code: "RELAY_UNAUTHORIZED", hard: false, activeSlots: 2, forwardedSlots: 2, queued: 1 });
      const expiredQueuedResult = await within(queuedExpiry.result, 3_000, "expired queued GET rejection");
      assert.equal(expiredQueuedResult.outcome, "complete");
      assert.equal(expiredQueuedResult.status, 401);
      await Promise.all([releaseGate(gateDir, expiryA.gate), releaseGate(gateDir, expiryB.gate)]);
      const expiryDrain = await Promise.all([expiryA.request.result, expiryB.request.result]);
      assertHeldResponse(expiryDrain[0], "first forwarded response across access expiry");
      assertHeldResponse(expiryDrain[1], "second forwarded response across access expiry");
      assert.equal((await getStatus(context, relay, expiring.accessToken)).status, 401,
        "natural access expiry denies a new HTTP request before the family WebSocket lease expires");
      const recoveredExpiry = await refreshDevice(context, relay, expiring, "refresh-after-access-expiry");
      assert.equal((await getStatus(context, relay, recoveredExpiry.accessToken)).status, 200,
        "unexpired durable refresh credential recovers after access-token expiry");
      evidence.cases.push({
        id: "natural-access-expiry-soft-drain",
        outcome: "PASS",
        queuedStatus: expiredQueuedResult.status,
        forwardedStatuses: expiryDrain.map(item => item.status),
        accessExpiresAt: expiring.expiresAt,
        familyLeaseExpiresAt: expiring.wsLeaseExpiresAt,
        observedAt: Date.now(),
        refreshedAfterExpiryStatus: 200,
        poolRetirement: expiryRetired,
      });

      // A separately paired, full-scope Gateway device revokes the target
      // family. Unlike routine refresh/expiry, revocation hard-closes active
      // forwarded channels and rejects the old queue without replay.
      const revokeTarget = await pairDevice(context, relay, gateway, "revoke-target");
      const administrator = await pairDevice(context, relay, gateway, "revoke-administrator");
      const revokeA = await holdGate(revokeTarget, "revoke-a1");
      const revokeB = await holdGate(revokeTarget, "revoke-a2");
      const revokeQueue = expectQueueInsertion();
      const queuedRevokeGate = await createHoldGate(gateDir, "revoke-queued", gateIds);
      const queuedRevoke = beginRelayRequest(context, relay, {
        path: "/api/servers", accessToken: revokeTarget.accessToken, holdId: queuedRevokeGate.id,
      });
      await queuedRevoke.sent;
      const queuedRevokeObserved = await within(revokeQueue, 3_000, "family-revoke queue insertion");
      assert.equal(queuedRevokeObserved.queueDepth, 1);
      const revokeRetirement = expectRetirement("RELAY_UNAUTHORIZED", true, queuedRevokeObserved.poolOrdinal);
      const revokeResponse = await beginRelayRequest(context, relay, {
        path: `/api/mobile/devices/${encodeURIComponent(revokeTarget.deviceId)}`,
        method: "DELETE",
        accessToken: administrator.accessToken,
      }).result;
      assert.equal(revokeResponse.outcome, "complete", "device revoke completes over Relay HTTP");
      assert.equal(revokeResponse.status, 204, "real C22 Gateway accepts full-scope device-family revoke");
      const revokeRetired = await within(revokeRetirement, 3_000, "hard Relay family-revoke pool invalidation");
      assert.deepEqual({ code: revokeRetired.code, hard: revokeRetired.hard, activeSlots: revokeRetired.activeSlots,
        forwardedSlots: revokeRetired.forwardedSlots, queued: revokeRetired.queued },
      { code: "RELAY_UNAUTHORIZED", hard: true, activeSlots: 2, forwardedSlots: 2, queued: 1 });
      const queuedRevokeResult = await within(queuedRevoke.result, 3_000, "revoked queued request rejection");
      assert.equal(queuedRevokeResult.outcome, "complete");
      assert.equal(queuedRevokeResult.status, 401);
      const hardClosed = await Promise.all([revokeA.request.result, revokeB.request.result]);
      assertClosedResponse(hardClosed[0], "first forwarded request after family revoke");
      assertClosedResponse(hardClosed[1], "second forwarded request after family revoke");
      await Promise.all([
        waitForGate(gateDir, revokeA.gate, "cancelled", 3_000),
        waitForGate(gateDir, revokeB.gate, "cancelled", 3_000),
      ]);
      evidence.gatewayResponseGate.cancelled += 2;
      const revokedRefresh = await relayJson(context, relay, {
        path: "/api/mobile/session/refresh",
        method: "POST",
        body: { refreshToken: revokeTarget.refreshToken, rotationId: `revoked-${randomUUID()}`, deviceId: revokeTarget.deviceId },
      });
      assert.equal(revokedRefresh.status, 401, "revoked family rejects its durable refresh credential");
      assert.equal((await getStatus(context, relay, administrator.accessToken)).status, 200,
        "revoking one device family leaves the administrator device usable");
      evidence.cases.push({
        id: "hard-family-revoke",
        outcome: "PASS",
        revokeStatus: revokeResponse.status,
        queuedStatus: queuedRevokeResult.status,
        forwardedOutcomes: hardClosed.map(item => item.outcome),
        oldRefreshStatus: revokedRefresh.status,
        administratorStatus: 200,
        poolRetirement: revokeRetired,
      });
      revokeResponse.body.fill(0);
      revokedRefresh.body.fill(0);

      // A Relay control-channel replacement is a new control generation. It
      // hard-closes the previous-generation active pool; the same still-valid
      // access grant can open a new pool after the replacement control comes up.
      const generationGrant = await pairDevice(context, relay, gateway, "control-generation");
      const generationPoolWaiter = expectPoolAcquisition();
      const generationA = await holdGate(generationGrant, "generation-a1");
      const generationPool = await within(generationPoolWaiter, 3_000, "control-generation target pool acquisition");
      const generationB = await holdGate(generationGrant, "generation-a2");
      const generationRetirement = expectRetirement("RELAY_UNAVAILABLE", true, generationPool.poolOrdinal);
      const priorCloseCount = relayClient.eventState.counts.control_close;
      const controlOnlyDisconnect = await installControlOnlyDisconnect(relayRuntimeRoot, relay.controlPort);
      let generationRetired;
      let generationClosed;
      try {
        relayClient.client.close();
        await waitUntil(() => relayClient.eventState.counts.control_close > priorCloseCount,
          3_000, "old Relay control channel close");
        assert.equal(relayClient.eventState.lastControlEvent?.event, "control_close",
          "the close barrier was observed independently of the bounded event transcript");
        assert.equal(controlOnlyDisconnect.snapshot().controlTerminateCalls, 1,
          "the test disconnect terminates the real control WebSocket");
        assert.ok(controlOnlyDisconnect.snapshot().dataTerminateSuppressed >= 2,
          "the test holds both active data WebSockets open until Relay retires the old generation");
        generationRetired = await within(generationRetirement, 3_000, "previous control-generation pool hard invalidation");
        assert.deepEqual({ code: generationRetired.code, hard: generationRetired.hard, activeSlots: generationRetired.activeSlots,
          forwardedSlots: generationRetired.forwardedSlots },
        { code: "RELAY_UNAVAILABLE", hard: true, activeSlots: 2, forwardedSlots: 2 });
        generationClosed = await Promise.all([generationA.request.result, generationB.request.result]);
        assertClosedResponse(generationClosed[0], "first request after old Relay control-generation close");
        assertClosedResponse(generationClosed[1], "second request after old Relay control-generation close");
        await Promise.all([
          waitForGate(gateDir, generationA.gate, "cancelled", 3_000),
          waitForGate(gateDir, generationB.gate, "cancelled", 3_000),
        ]);
        evidence.gatewayResponseGate.cancelled += 2;
      } finally {
        evidence.controlOnlyDisconnect = controlOnlyDisconnect.snapshot();
        controlOnlyDisconnect.restore();
      }
      relayClient = createClient();
      await within(relayClient.ready, 8_000, "replacement Relay control channel");
      const replacementOpenBefore = relayClient.eventState.counts.data_open;
      assert.equal(replacementOpenBefore, 0, "new control channel has no data channel before its first GET");
      assert.equal((await getStatus(context, relay, generationGrant.accessToken)).status, 200,
        "unexpired same-grant HTTP GET succeeds through the replacement control generation");
      assert.equal(relayClient.eventState.counts.data_open, 1,
        "replacement control generation opens one fresh data channel for its first GET");
      evidence.cases.push({
        id: "control-generation-hard-invalidation",
        outcome: "PASS",
        forwardedOutcomes: generationClosed.map(item => item.outcome),
        replacementControlOpen: relayClient.eventState.counts.control_open,
        replacementDataOpen: relayClient.eventState.counts.data_open,
        controlOnlyDisconnect: evidence.controlOnlyDisconnect,
        poolRetirement: generationRetired,
      });

      evidence.result = "passed";
      evidence.poolAcquireObservations = observedPoolAcquireEvents;
      evidence.queueObservations = observedQueueEvents;
      evidence.retirementObservations = observedRetireEvents;
      evidence.clientEvents = activeClientRecords.flatMap((record, index) => record.records.map(event => ({ clientOrdinal: index + 1, ...event })));
      evidence.clientEventSummaries = summarizeClientEvents(activeClientRecords);
      evidence.gatewayResponseGate.completed = evidence.gatewayResponseGate.captured - evidence.gatewayResponseGate.cancelled;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      evidence.result = "failed";
      evidence.failureName = failure.name;
      evidence.failureCode = typeof failure.code === "string" ? failure.code : null;
    } finally {
      if (restorePoolObservers) restorePoolObservers();
      if (relay && evidence.gatewayResponseGate.loaded) {
        await releaseAllGates(context.pathInState("gateway-fixture", "response-gates"), gateIds)
          .catch(error => { failure ??= error; evidence.result = "failed"; });
      }
      if (gatewayRuntimeBefore) {
        try {
          evidence.gatewayLiveSourceProvenanceAfter = await observeLiveGatewaySourceProvenance();
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error));
          evidence.result = "failed";
        }
      }
      if (gatewayRuntimeBefore) {
        try {
          evidence.gatewayRuntimeAfter = await verifyFrozenGatewayRuntime();
          assert.equal(evidence.gatewayRuntimeAfter.manifestSha256, gatewayRuntimeBefore.manifestSha256,
            "frozen C22 Gateway runtime manifest remains unchanged during the isolated run");
          assert.equal(evidence.gatewayRuntimeAfter.sourceTreeSha256, gatewayRuntimeBefore.sourceTreeSha256);
          assert.equal(evidence.gatewayRuntimeAfter.dependencyTreeSha256, gatewayRuntimeBefore.dependencyTreeSha256);
          assert.equal(evidence.gatewayRuntimeAfter.binarySha256, gatewayRuntimeBefore.binarySha256);
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error));
          evidence.result = "failed";
        }
      }
      if (gatewayHarnessInputsBefore) {
        try {
          evidence.gatewayHarnessInputsAfter = await verifyGatewayHarnessInputs();
          assert.deepEqual(evidence.gatewayHarnessInputsAfter, gatewayHarnessInputsBefore,
            "Gateway test harness imports remain unchanged during the isolated run");
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error));
          evidence.result = "failed";
        }
      }
      if (frozenRelay) {
        try {
          const relayAfter = await verifyRelayFrozenSource();
          assert.equal(relayAfter.manifestSha256, frozenRelay.manifestSha256, "Relay manifest is unchanged after the run");
          assert.deepEqual(relayAfter.support, frozenRelay.support,
            "all 14 hash-pinned Relay support inputs remain unchanged after the run");
          evidence.relayLiveSourceProvenanceAfter = relayAfter.liveSupportProvenance;
          const runtimeAfter = await verifyRelayRuntime(relayRuntimeRoot, frozenRelay);
          evidence.relayRuntimeCopyAfter = runtimeAfter;
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error));
          evidence.result = "failed";
        }
      }
      evidence.queueObservations = observedQueueEvents;
      evidence.poolAcquireObservations = observedPoolAcquireEvents;
      evidence.retirementObservations = observedRetireEvents;
      evidence.clientEvents = activeClientRecords.flatMap((record, index) => record.records.map(event => ({ clientOrdinal: index + 1, ...event })));
      evidence.clientEventSummaries = summarizeClientEvents(activeClientRecords);
      evidence.gatewayHttpResponses = context.gatewayHttpResponseDiagnostics || [];
      try {
        await context.writeArtifactJson("relay-get-pool-static03-c22-auth-lifecycle.json", evidence);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
        evidence.result = "failed-artifact-write";
      }
    }
    if (failure) throw failure;
    return { result: evidence.result, cases: evidence.cases.map(item => item.id), gatewayFileCount: GATEWAY_FILE_COUNT };
  },
);
