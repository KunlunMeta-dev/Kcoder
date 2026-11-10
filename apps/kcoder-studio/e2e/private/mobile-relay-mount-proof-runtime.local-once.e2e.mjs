import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { chmod, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMobileLatencyHelpers } from "../harness/mobile-latency-helpers.mjs";
import { materializeMatchedMobileStaticDist } from "../harness/matched-mobile-static-dist.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { materializeWorkspace } from "../harness/workspace-fixture.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const RUN_FLAG = "KCODER_E2E_LOCAL_MOUNT_PROOF_RUNTIME_ONCE";
const NODE22_EXECUTABLE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const RELAY_NODE_EXECUTABLE = resolve(repoRoot, "target/private-node18-relay-compat/node-v18.19.1-linux-x64/bin/node");
const EXPECTED_RELAY_NODE_VERSION = "v18.19.1";
const RELAY_WORKER_PATH = resolve(repoRoot, "apps/kcoder-studio/e2e/private/helpers/mobile-relay-node18-worker.mjs");
const BASE_COMMIT = "e698ae47017a43813256a74b83b660474a0dbdaa";
const SERVER_PATH = "apps/kcoder-relay/src/server.mjs";
const SERVER_SHA256 = "9e0297d571e3962c5b88bea2971dd3924e253a84b03fad034960b0be9a97d455";
const TRANSPORT_SHA256 = "6a56287394425ce297a2c87534c739645cd85eb99efc707ffe9d1ce6a8277d7c";
const GET_POOL_SHA256 = "1ac7a3e9806c0e57a86300497139d34be9c6143d68d1b18f57e49ba72742c923";
const MAIN_REPO_ROOT = resolve(repoRoot, "../..");
const RELAY_SOURCE_PINS = Object.freeze({
  "apps/kcoder-relay/src/server.mjs": SERVER_SHA256,
  "apps/kcoder-relay/src/transport.mjs": TRANSPORT_SHA256,
  "apps/kcoder-relay/src/http-get-pool.mjs": GET_POOL_SHA256,
  "apps/kcoder-relay/src/server-routing.mjs": "b0f4c2519d75c464227d4b2d7bbc5b9d8cdc19e26690daf0fb1644d13893c4bb",
  "apps/kcoder-relay/src/config.mjs": "b24e5c93198e0b5e0d9478785d5be8ecb826bb69479ac3a4a04a09acdd762335",
  "apps/kcoder-relay/src/registration-store.mjs": "ea310dd7a31a4e1d4f8a62ecedff84dba219cefa08ab64b89fd38c4fb186cf78",
  "apps/kcoder-relay/src/client.mjs": "339d7d85a203d2a6293138c000d0a17aa6bb0de1ae40bb9e524aae0073d988f8",
  "apps/kcoder-relay/src/client-identity.mjs": "c9e22731e4b553b1060f5dc4060de5ff4f37483527ade1a28104741c2500aa7d",
  "apps/kcoder-relay/package.json": "9c9899c86c106b0ccbce4c635f6a8df0128559ab5bcedff5ed72cca84db095cb",
});
const WS_PIN = Object.freeze({
  version: "8.22.0",
  packageTreeSha256: "3271cba667fdc4721ed9fe275eae78247d07ded06cddd52b824359880aeb4c1d",
});
const GATEWAY_SNAPSHOT = resolve(repoRoot, "target/private-phone-ux-implementation/shared-gateway-current-20261009/snapshot-20261009-223221.326Z");
const GATEWAY_PINS = Object.freeze({
  manifestSha256: "0219dce48d65e6413ce60d0aadfe1fe8047426c6570689ecaf77d757f256cda5",
  sourceTreeSha256: "6a8255fa538d6f2534d1784a088de9757283e8935e69a0d78a95358bb49ae197",
  dependencyTreeSha256: "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954",
});
const MATCHED_MOBILE_INPUT_ROOT = resolve(repoRoot, "target/private-phone-ux-validation/new-common-dependencies-before10feb-after992-20261009/run-d065c8c452c648f7/comparison-9925461c");
const MATCHED_MOBILE_INPUT = Object.freeze({
  comparisonId: "matched-deploy-mounted-191920",
  bundleRoot: resolve(MATCHED_MOBILE_INPUT_ROOT, "bundle"),
  exportManifestPath: resolve(MATCHED_MOBILE_INPUT_ROOT, "export-manifest.json"),
  expectedExportManifestSha256: "f2f262624d4a2286ef31e250fb1752e02ab9a41232196b5591dafc5d8369d14d",
  expectedBundleSha256: "e4a7277de6ecb2afb8f68dee52dfdf3b5a270c0e0c2e7f46cbdba02e83e140ab",
  expectedSourceTreeSha256: "b22dbddabf802b08a4a586de178c875b576a8279efc51d142a6f1948e40dd020",
  expectedDependencySourceTreeSha256: "46b02fc5ac823118f6eb2c034ea3f1d9cbbf79b71041fc2fa848f79a9abca1c6",
  expectedDependencyOwnedTreeSha256: "51b0c6987324fa5b6dbc17d8ea34ff83dd832deaa06c9c1193f84465a89001e4",
  expectedDependencyFileCount: 52_524,
  expectedInputRoots: Object.freeze([
    Object.freeze({ name: "mobile", destination: "apps/kcoder-studio/mobile", sha256: "8a0963fb62846395dcdf1162470452d20fff84eed51adb44311fb75c5d327455", fileCount: 350 }),
    Object.freeze({ name: "studio-shared", destination: "apps/kcoder-studio/shared", sha256: "5443f5e695e75b82a1365baf90a3c280239bead8855647becfa2c9d67e91fe88", fileCount: 19 }),
  ]),
});
const GATEWAY_BINARY = resolve(repoRoot, "target/private-b6-device-revoke-20261009/build-03/owned-kcoder-copy");
const GATEWAY_BINARY_SHA256 = "bc985854134edffc02415a5d9e72f8905fdc23e7e2263e84f9554e53619dec29";
const RELAY_AUTHORITY = "mobile-mount.test:8451";
const RELAY_ORIGIN = `http://${RELAY_AUTHORITY}`;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

assert.equal(process.env[RUN_FLAG], "1", `${RUN_FLAG}=1 is required for this private local runtime test`);
assert.equal(process.execPath, NODE22_EXECUTABLE, "keep the once runner and Gateway freeze verification on the pinned Node 22 runtime");
assert.equal(process.version, "v22.17.0", "use the exact reviewed Node 22 runtime version for the runner");
assert.equal(execFileSync(RELAY_NODE_EXECUTABLE, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim(), EXPECTED_RELAY_NODE_VERSION,
  "run the local Relay service using the exact production Node 18.19.1 version");
assert.equal(process.argv.length, 2, "the once runner accepts no extra arguments");

await runE2E(import.meta.url, {
  testId: "mobile-optimized-relay-runtime-local-once",
  tier: "local-contract",
  cleanupTimeoutMs: 30_000,
  bodyAbortTimeoutMs: 10_000,
  retainSuccessLogs: true,
  modelPolicy: "current optimized Relay source closure with actual loopback HTTP/WebSocket routing into the fixed KCODER_STUDIO_MOCK Gateway and matched 992 Mobile Web export; no public service, browser, provider, or model turn",
}, async context => {
  const sha256 = value => createHash("sha256").update(value).digest("hex");
  const evidence = {
    state: "running",
    stage: "input-validation",
    authority: "RunContext result.json and manifest.json",
    runtime: { nodeVersion: process.version, nodeExecutable: process.execPath, relayNodeVersion: EXPECTED_RELAY_NODE_VERSION,
      relayNodeExecutable: RELAY_NODE_EXECUTABLE, relayNodeSha256: null, relayWorkerSourceSha256: null, relayWorkerPid: null,
      relaySourceCommit: BASE_COMMIT, relaySourceClosure: [], relayServerSha256: null, transportSha256: null,
      getPoolSha256: null, releaseManifestSha256: null, wsVersion: null, wsPackageTreeSha256: null },
    gateway: { mock: true, providerCalls: 0, binaryConfiguredButNotExecuted: true, binarySha256: GATEWAY_BINARY_SHA256,
      devServerNodeExecutable: process.execPath, snapshotManifestSha256: null, sourceTreeSha256: null, dependencyTreeSha256: null },
    mobileDist: { inputKind: null, comparisonId: null, exportManifestSha256: null, bundleSha256: null,
      manifestSha256: null, resourceCount: null, totalResourceBytes: null },
    relay: { registrationPostCount: 0, registrationStatus: null, controlOnline: false, controlPortOwned: false, proxyPortOwned: false,
      pairingStatus: null, authenticatedGetStatuses: [], clientOpenEventsBeforeGet: null, clientOpenEventsAfterFirstGet: null,
      clientOpenEventsAfterSecondGet: null, getPoolConnectionReused: false, mobileRpcWebSocketOpened: false },
    routing: { entryStatus: null, entryContentType: null, entrySchemaValid: false, selectedUrlsExact: false,
      directGatewayHtmlStatus: null, directGatewayHtmlContentType: null, htmlStatus: null, htmlContentType: null,
      htmlBytes: null, assets: [], forgedMobileHeadersSuperseded: false, apiStatus: null, apiUnauthenticatedStillRejected: false },
    deployment: { attempted: false, productionServiceTouched: false },
  };
  context.addCleanup("write local mount-proof runtime evidence", async () => {
    if (evidence.state === "running") evidence.state = "incomplete";
    await context.writeArtifactJsonInternal("local-optimized-relay-runtime.json", evidence);
  });

  try {
  evidence.stage = "source-and-dependency-pins";
  const relayInputs = await loadPinnedRelayInputs(sha256);
  evidence.runtime.relaySourceClosure = relayInputs.rows;
  evidence.runtime.relayServerSha256 = relayInputs.relayServerSha256;
  evidence.runtime.transportSha256 = relayInputs.transportSha256;
  evidence.runtime.getPoolSha256 = relayInputs.getPoolSha256;
  evidence.runtime.wsVersion = relayInputs.wsVersion;
  evidence.runtime.wsPackageTreeSha256 = relayInputs.wsTreeSha256;
  evidence.stage = "materialize-optimized-relay-release";
  const runtimeRoot = context.pathInState("relay-runtime");
  const releaseArtifactRoot = context.pathInArtifacts("optimized-relay-release");
  await materializePinnedRelayRuntime(context, runtimeRoot, releaseArtifactRoot, relayInputs.files);
  evidence.runtime.releaseManifestSha256 = await createHashFile(join(releaseArtifactRoot, "manifest.json"));
  const clientModule = await import(pathToFileURL(resolve(runtimeRoot, "apps/kcoder-relay/src/client.mjs")).href);
  const WebSocket = createRequire(resolve(MAIN_REPO_ROOT, "apps/kcoder-relay/src/client.mjs"))("ws");
  assert.equal(typeof clientModule.startRegisteredClient, "function");
  evidence.runtime.relayNodeSha256 = sha256(await readFile(RELAY_NODE_EXECUTABLE));
  evidence.runtime.relayWorkerSourceSha256 = sha256(await readFile(RELAY_WORKER_PATH));

  evidence.stage = "validate-fixed-gateway-runtime";
  const mobileHelpers = createMobileLatencyHelpers({ sha256 });
  const gatewayRuntime = await mobileHelpers.prepareGatewayRuntimeSnapshot(context, GATEWAY_SNAPSHOT, GATEWAY_BINARY, GATEWAY_BINARY_SHA256);
  assert.equal(gatewayRuntime.manifestSha256, GATEWAY_PINS.manifestSha256);
  assert.equal(gatewayRuntime.manifest.sourceTreeSha256, GATEWAY_PINS.sourceTreeSha256);
  assert.equal(gatewayRuntime.manifest.dependencyTreeSha256, GATEWAY_PINS.dependencyTreeSha256);
  assert.equal(gatewayRuntime.manifest.status, "complete");
  assert.equal(gatewayRuntime.manifest.nodeVersion, "v22.17.0");
    evidence.gateway.snapshotManifestSha256 = gatewayRuntime.manifestSha256;
    evidence.gateway.sourceTreeSha256 = gatewayRuntime.manifest.sourceTreeSha256;
    evidence.gateway.dependencyTreeSha256 = gatewayRuntime.manifest.dependencyTreeSha256;

  evidence.stage = "materialize-matched-mobile-dist";
  const mobileDist = await materializeMatchedMobileStaticDist(context, {
    ...MATCHED_MOBILE_INPUT,
    outputName: "matched-mobile-web-dist",
    stagingName: "matched-mobile-web-dist-source",
    artifactName: "matched-mobile-deploy-mount.json",
  });
  assert.equal(mobileDist.resourceCount, 37);
  evidence.mobileDist = { inputKind: mobileDist.inputKind, comparisonId: mobileDist.comparisonId,
    exportManifestSha256: mobileDist.sourceExportManifestSha256, bundleSha256: mobileDist.bundleSha256,
    manifestSha256: mobileDist.manifestSha256, resourceCount: mobileDist.resourceCount,
    totalResourceBytes: mobileDist.totalResourceBytes };

  evidence.stage = "start-isolated-mock-gateway";
  const workspace = await materializeWorkspace(context, "minimal", { instanceId: "relay-mount-proof-runtime" });
  const pairingToken = randomBytes(32).toString("hex");
  const registrationKey = randomBytes(32).toString("hex");
  context.registerSecret(pairingToken);
  context.registerSecret(registrationKey);
  const gatewayHome = context.pathInState("gateway-home");
  const gatewayConfig = context.pathInState("gateway-config");
  await Promise.all([mkdir(gatewayHome, { recursive: true, mode: 0o700 }), mkdir(gatewayConfig, { recursive: true, mode: 0o700 })]);
  const serversFile = await context.writeStateJson("servers.json", [{ id: "runtime-smoke", label: "Runtime smoke", runtime: "kcoder",
    transport: "local", command: GATEWAY_BINARY, workspace: workspace.path }]);
  const gateway = await startGateway(context, {
    label: "local-mount-proof-gateway",
    auth: true,
    authToken: pairingToken,
    gatewayRoot: gatewayRuntime.root,
    cwd: gatewayRuntime.root,
    workspace: workspace.path,
    serversFile,
    serversStore: context.pathInState("servers-store.json"),
    kcoderBin: GATEWAY_BINARY,
    env: {
      KCODER_STUDIO_MOCK: "1",
      KCODER_STUDIO_WEB_ROOT: "",
      KCODER_STUDIO_MOBILE_WEB_ROOT: mobileDist.ownedRoot,
      KCODER_STUDIO_PUBLIC_ORIGINS: RELAY_ORIGIN,
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: RELAY_ORIGIN,
      KCODER_STUDIO_SECURE_COOKIE: "1",
      KCODER_CONFIG_DIR: gatewayConfig,
      KCODER_HOME: gatewayHome,
    },
  });
  evidence.stage = "owned-gateway-running";

  const registrationStoreFile = context.pathInState("relay/registration-store.json");
  await mkdir(dirname(registrationStoreFile), { recursive: true, mode: 0o700 });
  const relayReadyFile = context.pathInState("relay/node18-ready.json");
  const relayWorkerConfig = await context.writeStateJson("relay/node18-config.json", {
    serverModule: resolve(runtimeRoot, "apps/kcoder-relay/src/server.mjs"),
    registrationKey,
    registrationStoreFile,
    readyFile: relayReadyFile,
    sharedHosts: [RELAY_AUTHORITY],
    connectTimeout: 10_000,
  });
  const relayProcess = context.spawnOwned("owned-local-relay-node18", RELAY_NODE_EXECUTABLE,
    [RELAY_WORKER_PATH, relayWorkerConfig], { cwd: runtimeRoot });
  evidence.runtime.relayWorkerPid = relayProcess.pid;
  const relay = await waitFor(async () => {
    if (relayProcess.exitCode !== null) throw new Error(`Node 18 local Relay worker exited with code ${relayProcess.exitCode}`);
    let ready;
    try { ready = JSON.parse(await readFile(relayReadyFile, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    assert.deepEqual(Object.keys(ready).sort(), ["controlPort", "proxyPort"]);
    for (const key of ["controlPort", "proxyPort"]) assert.ok(Number.isInteger(ready[key]) && ready[key] > 0 && ready[key] <= 65_535);
    return ready;
  }, 10_000, "Node 18 local Relay startup", 25, context.abortSignal);
  context.registerPort("local Relay control", relay.controlPort);
  context.registerPort("local Relay public proxy", relay.proxyPort);
  evidence.relay.controlPortOwned = true;
  evidence.relay.proxyPortOwned = true;

  evidence.stage = "register-local-identity-and-connect-control";
  let controlOnline = false;
  const clientEvents = [];
  const identityFile = context.pathInState("relay/client-identity.json");
  let registrationStatus = null;
  let registrationPostCount = 0;
  const observeRegistrationFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, `http://127.0.0.1:${relay.controlPort}`, "client registration stays on the owned loopback Relay control listener");
    assert.equal(url.pathname, "/_relay/register", "client uses the pinned Relay registration endpoint");
    assert.equal(init.method, "POST", "registration is the expected single POST");
    registrationPostCount += 1;
    const response = await fetch(input, init);
    registrationStatus = response.status;
    evidence.relay.registrationPostCount = registrationPostCount;
    evidence.relay.registrationStatus = registrationStatus;
    return response;
  };
  const relayClient = await clientModule.startRegisteredClient({
    url: `http://127.0.0.1:${relay.controlPort}`,
    registrationKey,
    pairingToken,
    identityFile,
    gateway: gateway.baseUrl,
    allowInsecure: true,
    retryMs: 250,
    onOnline: () => { controlOnline = true; },
    onDiagnostic: record => {
      if (record?.event === "open_received" && clientEvents.length < 128) clientEvents.push(record.event);
    },
    fetchImpl: observeRegistrationFetch,
  });
  context.addCleanup("close owned local Relay client", async () => { relayClient.close(); });
  assert.equal(registrationPostCount, 1, "one local registration POST creates the run-owned identity");
  assert.equal(registrationStatus, 201, "the isolated local Relay accepts the run-owned registration");
  await waitFor(() => controlOnline, 15_000, "owned Gateway control channel connected to the local source-pinned Relay", 50, context.abortSignal);
  evidence.relay.controlOnline = true;
  evidence.stage = "local-shared-host-routing";

  const identity = JSON.parse(await readFile(identityFile, "utf8"));
  assert.equal(typeof identity.id, "string");
  assert.equal(typeof identity.secret, "string");
  if (identity.id.length >= 8) context.registerSecret(identity.id);
  context.registerSecret(identity.secret);
  const id = identity.id;
  const mountPrefix = `/g/${id}/mobile`;
  const forgedHeaders = {
    "x-kcoder-mobile-mount": "/g/forged",
    "x-kcoder-mobile-mount-proof": "forged-proof",
  };

  const entryPath = `/g/${id}/mobile-entry`;
  const entry = await relayHttpGet(relay.proxyPort, RELAY_AUTHORITY, entryPath, forgedHeaders);
  evidence.routing.entryStatus = entry.status;
  evidence.routing.entryContentType = contentType(entry.headers);
  assert.equal(entry.status, 200, "real shared-host Relay route reaches the Gateway mobile-entry handler");
  assert.match(evidence.routing.entryContentType, /^application\/json$/);
  const entryJson = JSON.parse(entry.body.toString("utf8"));
  const expectedEntryKeys = ["available", "gatewayUrl", "mobileUrl", "version"];
  assert.deepEqual(Object.keys(entryJson).sort(), expectedEntryKeys);
  assert.equal(entryJson.version, 1);
  assert.equal(entryJson.available, true);
  const expectedGatewayUrl = `${RELAY_ORIGIN}/g/${id}`;
  const expectedMobileUrl = `${RELAY_ORIGIN}${mountPrefix}/`;
  assert.equal(entryJson.gatewayUrl, expectedGatewayUrl);
  assert.equal(entryJson.mobileUrl, expectedMobileUrl);
  for (const value of [entryJson.gatewayUrl, entryJson.mobileUrl]) {
    const parsed = new URL(value);
    assert.equal(parsed.origin, RELAY_ORIGIN);
    assert.equal(parsed.username, "");
    assert.equal(parsed.password, "");
    assert.equal(parsed.search, "");
    assert.equal(parsed.hash, "");
    assert.equal(value.includes(pairingToken), false);
    assert.equal(value.includes(registrationKey), false);
    assert.equal(value.includes(identity.secret), false);
  }
  evidence.routing.entrySchemaValid = true;
  evidence.routing.selectedUrlsExact = true;

  const htmlPath = `${mountPrefix}/`;
  const directGatewayHtml = await relayHttpGet(gateway.port, RELAY_AUTHORITY, "/mobile/", {});
  evidence.routing.directGatewayHtmlStatus = directGatewayHtml.status;
  evidence.routing.directGatewayHtmlContentType = contentType(directGatewayHtml.headers);
  const html = await relayHttpGet(relay.proxyPort, RELAY_AUTHORITY, htmlPath, forgedHeaders);
  evidence.routing.htmlStatus = html.status;
  evidence.routing.htmlContentType = contentType(html.headers);
  evidence.routing.htmlBytes = html.body.length;
  assert.equal(html.status, 200, "real shared-host Relay route serves the matched Mobile Web HTML with caller-forged proof headers");
  assert.match(evidence.routing.htmlContentType, /^text\/html$/);
  assert.ok(html.body.length > 0);
  const assets = extractAssets(html.body.toString("utf8"), `${RELAY_ORIGIN}${htmlPath}`);
  const cssAssets = assets.filter(asset => asset.kind === "css");
  const jsAssets = assets.filter(asset => asset.kind === "javascript");
  assert.ok(cssAssets.length > 0, "matched Mobile HTML declares at least one stylesheet");
  assert.ok(jsAssets.length > 0, "matched Mobile HTML declares at least one JavaScript bundle");
  for (const [kind, rows] of [["css", cssAssets], ["javascript", jsAssets]]) {
    for (const asset of rows) {
      const response = await relayHttpGet(relay.proxyPort, RELAY_AUTHORITY, asset.path, forgedHeaders);
      const type = contentType(response.headers);
      const row = { kind, status: response.status, contentType: type, responseBytes: response.body.length };
      evidence.routing.assets.push(row);
      assert.equal(response.status, 200, `matched hosted ${kind} asset returns HTTP 200 through actual Relay and Gateway servers`);
      assert.ok(response.body.length > 0, `matched hosted ${kind} asset has a nonempty response`);
      if (kind === "css") assert.match(type, /^text\/css$/);
      if (kind === "javascript") assert.match(type, /^(?:application|text)\/javascript$/);
    }
  }
  evidence.routing.forgedMobileHeadersSuperseded = true;

  const api = await relayHttpGet(relay.proxyPort, RELAY_AUTHORITY, `/g/${id}/api/servers`, forgedHeaders);
  evidence.routing.apiStatus = api.status;
  evidence.routing.apiUnauthenticatedStillRejected = api.status === 401;
  assert.equal(api.status, 401, "mount presentation proof does not authorize an ordinary Gateway API request");

  evidence.stage = "pair-and-exercise-authenticated-get-pool";
  const pairing = await relayHttpRequest(relay.proxyPort, RELAY_AUTHORITY, `/g/${id}/api/mobile/session`, {
    method: "POST",
    headers: { ...forgedHeaders, "content-type": "application/json" },
    body: JSON.stringify({ token: pairingToken, durableDeviceAuthorization: true, deviceLabel: "local optimized Relay smoke" }),
  });
  evidence.relay.pairingStatus = pairing.status;
  assert.equal(pairing.status, 200, "the isolated Gateway accepts a local durable mobile pairing");
  assert.equal(contentType(pairing.headers), "application/json");
  assert.equal(pairing.headers["set-cookie"], undefined);
  assert.equal(pairing.headers["cache-control"], "no-store");
  const grant = JSON.parse(pairing.body.toString("utf8"));
  for (const name of ["accessToken", "refreshToken", "rpcToken"]) {
    assert.equal(typeof grant[name], "string");
    context.registerSecret(grant[name]);
  }
  assert.equal(grant.capabilities?.mobileRefreshV1, true);
  assert.equal(grant.capabilities?.mobileDeviceManagementV1, true);
  const rpcSocket = new WebSocket(
    `ws://127.0.0.1:${relay.proxyPort}/g/${id}/rpc?token=${encodeURIComponent(grant.rpcToken)}`,
    { headers: { host: RELAY_AUTHORITY, authorization: `Bearer ${grant.accessToken}` }, handshakeTimeout: 5_000, perMessageDeflate: false },
  );
  context.addCleanup("close owned local mobile RPC WebSocket", async () => {
    if (rpcSocket.readyState === WebSocket.CLOSED) return;
    if (rpcSocket.readyState !== WebSocket.OPEN) { rpcSocket.terminate(); return; }
    rpcSocket.close();
    await Promise.race([new Promise(resolvePromise => rpcSocket.once("close", resolvePromise)), new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))]);
    if (rpcSocket.readyState !== WebSocket.CLOSED) rpcSocket.terminate();
  });
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("local authenticated RPC WebSocket timed out")), 7_000);
    rpcSocket.once("open", () => { clearTimeout(timer); resolvePromise(); });
    rpcSocket.once("unexpected-response", () => { clearTimeout(timer); reject(new Error("local authenticated RPC WebSocket was rejected")); });
    rpcSocket.once("error", () => { clearTimeout(timer); reject(new Error("local authenticated RPC WebSocket failed")); });
  });
  evidence.relay.mobileRpcWebSocketOpened = true;
  const closedRpc = new Promise(resolvePromise => rpcSocket.once("close", resolvePromise));
  rpcSocket.close();
  await Promise.race([closedRpc, new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))]);
  if (rpcSocket.readyState !== WebSocket.CLOSED) rpcSocket.terminate();

  const openEventCount = () => clientEvents.filter(event => event === "open_received").length;
  evidence.relay.clientOpenEventsBeforeGet = openEventCount();
  for (let index = 0; index < 2; index += 1) {
    const response = await relayHttpGet(relay.proxyPort, RELAY_AUTHORITY, `/g/${id}/api/servers`, {
      ...forgedHeaders,
      authorization: `Bearer ${grant.accessToken}`,
    });
    evidence.relay.authenticatedGetStatuses.push(response.status);
    assert.equal(response.status, 200, "paired access token authorizes a Gateway read through the optimized Relay");
    assert.match(contentType(response.headers), /^application\/json$/);
    JSON.parse(response.body.toString("utf8"));
    if (index === 0) evidence.relay.clientOpenEventsAfterFirstGet = openEventCount();
    if (index === 1) evidence.relay.clientOpenEventsAfterSecondGet = openEventCount();
  }
  assert.ok(evidence.relay.clientOpenEventsAfterFirstGet > evidence.relay.clientOpenEventsBeforeGet,
    "the first authenticated GET establishes a data channel through the actual local Relay client");
  assert.equal(evidence.relay.clientOpenEventsAfterSecondGet, evidence.relay.clientOpenEventsAfterFirstGet,
    "the immediately repeated authenticated GET reuses that live client data channel");
  evidence.relay.getPoolConnectionReused = true;
  assert.ok(evidence.routing.assets.some(row => row.kind === "css" && row.status === 200));
  assert.ok(evidence.routing.assets.some(row => row.kind === "javascript" && row.status === 200));
  evidence.state = "PASS";
  evidence.stage = "complete";
  return { state: "PASS", relayServerSha256: evidence.runtime.relayServerSha256, transportSha256: evidence.runtime.transportSha256,
    getPoolSha256: evidence.runtime.getPoolSha256, relaySourceCommit: BASE_COMMIT,
    matchedMobileExportManifestSha256: mobileDist.sourceExportManifestSha256, matchedMobileBundleSha256: mobileDist.bundleSha256,
    derivedMobileDistManifestSha256: mobileDist.manifestSha256, entryStatus: entry.status, htmlStatus: html.status,
    cssResponses: cssAssets.length, javascriptResponses: jsAssets.length, apiUnauthenticatedStatus: api.status,
    pairingStatus: pairing.status, authenticatedGetStatuses: evidence.relay.authenticatedGetStatuses,
    mobileRpcWebSocketOpened: evidence.relay.mobileRpcWebSocketOpened, getPoolConnectionReused: evidence.relay.getPoolConnectionReused };
  } catch (error) {
    evidence.state = "FAIL";
    evidence.failureClass = error?.name === "AssertionError" ? "assertion" : "runtime";
    const code = error?.code;
    evidence.failureCode = ["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EADDRINUSE", "ENOENT", "EACCES"].includes(code) ? code : null;
    throw error;
  }
});

async function loadPinnedRelayInputs(sha256) {
  const files = new Map();
  for (const [path, expected] of Object.entries(RELAY_SOURCE_PINS)) {
    const bytes = execFileSync("git", ["show", `${BASE_COMMIT}:${path}`], { cwd: repoRoot, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(sha256(bytes), expected, `pinned optimized Relay source hash changed: ${path}`);
    files.set(path, bytes);
  }
  assert.equal(sha256(files.get(SERVER_PATH)), SERVER_SHA256);
  assert.equal(sha256(files.get("apps/kcoder-relay/src/transport.mjs")), TRANSPORT_SHA256);
  assert.equal(sha256(files.get("apps/kcoder-relay/src/http-get-pool.mjs")), GET_POOL_SHA256);
  for (const path of [SERVER_PATH, "apps/kcoder-relay/src/transport.mjs", "apps/kcoder-relay/src/http-get-pool.mjs"]) {
    assert.ok(files.has(path), `optimized Relay release includes ${path}`);
  }

  const mainRelayRoot = resolve(MAIN_REPO_ROOT, "apps/kcoder-relay");
  const wsRoot = await realpath(resolve(mainRelayRoot, "node_modules/ws"));
  const clientPath = resolve(MAIN_REPO_ROOT, "apps/kcoder-relay/src/client.mjs");
  const wsEntry = await realpath(createRequire(clientPath).resolve("ws"));
  assert.equal(dirname(wsEntry), wsRoot, "pinned Relay ws dependency resolves from the existing main-checkout package");
  const wsPackage = JSON.parse(await readFile(resolve(wsRoot, "package.json"), "utf8"));
  assert.equal(wsPackage.version, WS_PIN.version);
  const wsRows = [];
  await walkPackageTree(wsRoot, wsRoot, sha256, wsRows);
  wsRows.sort(([left], [right]) => left.localeCompare(right));
  const wsTreeSha256 = sha256(Buffer.from(wsRows.map(([path, hash]) => `${path}\0${hash}\n`).join("")));
  assert.equal(wsTreeSha256, WS_PIN.packageTreeSha256);
  const rows = [...files].map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.length }));
  return { files, rows, wsRoot, wsVersion: wsPackage.version, wsTreeSha256,
    relayServerSha256: sha256(files.get(SERVER_PATH)),
    transportSha256: sha256(files.get("apps/kcoder-relay/src/transport.mjs")),
    getPoolSha256: sha256(files.get("apps/kcoder-relay/src/http-get-pool.mjs")) };
}

async function materializePinnedRelayRuntime(context, runtimeRoot, releaseArtifactRoot, files) {
  const releaseFiles = [SERVER_PATH, "apps/kcoder-relay/src/transport.mjs", "apps/kcoder-relay/src/http-get-pool.mjs"];
  const manifest = {
    sourceKind: "committed-source-snapshot",
    sourceCommit: BASE_COMMIT,
    deployedFiles: releaseFiles.map(path => ({
      path: path.slice("apps/kcoder-relay/".length),
      sha256: createHash("sha256").update(files.get(path)).digest("hex"),
      bytes: files.get(path).length,
    })),
    supportFiles: [...files.keys()].filter(path => !releaseFiles.includes(path)).map(path => ({
      path: path.slice("apps/kcoder-relay/".length),
      sha256: createHash("sha256").update(files.get(path)).digest("hex"),
      bytes: files.get(path).length,
    })),
    runtimeDependency: { wsVersion: WS_PIN.version, wsPackageTreeSha256: WS_PIN.packageTreeSha256 },
    boundary: "local runtime verification only; production deployment and performance are not asserted",
  };
  await mkdir(releaseArtifactRoot, { recursive: true, mode: 0o700 });
  for (const sourcePath of releaseFiles) {
    const destination = resolve(releaseArtifactRoot, sourcePath.slice("apps/kcoder-relay/".length));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, files.get(sourcePath), { flag: "wx", mode: 0o600 });
  }
  const manifestPath = join(releaseArtifactRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });

  for (const [path, bytes] of files) {
    const relativePath = path.slice("apps/kcoder-relay/".length);
    const destination = resolve(runtimeRoot, "apps/kcoder-relay", relativePath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    await chmod(destination, 0o600);
  }
  const mainRelayRoot = resolve(MAIN_REPO_ROOT, "apps/kcoder-relay");
  const wsRoot = await realpath(resolve(mainRelayRoot, "node_modules/ws"));
  const moduleDirectory = resolve(runtimeRoot, "apps/kcoder-relay/node_modules");
  await mkdir(moduleDirectory, { recursive: true, mode: 0o700 });
  await symlink(wsRoot, resolve(moduleDirectory, "ws"), "dir");
  for (const sourcePath of releaseFiles) {
    const runtimePath = resolve(runtimeRoot, sourcePath);
    assert.equal(await createHashFile(runtimePath), manifest.deployedFiles.find(row => row.path === sourcePath.slice("apps/kcoder-relay/".length)).sha256);
  }
  context.registerTemporaryDirectory("source-pinned local Relay runtime", runtimeRoot);
}

async function walkPackageTree(root, directory, sha256, rows) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, "the existing ws package tree contains no symlinked files");
    if (entry.isDirectory()) await walkPackageTree(root, path, sha256, rows);
    else {
      assert.ok(info.isFile());
      rows.push([relative(root, path).split("\\").join("/"), sha256(await readFile(path))]);
    }
  }
}

async function createHashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function relayHttpGet(port, authority, path, headers) {
  return relayHttpRequest(port, authority, path, { method: "GET", headers });
}

function relayHttpRequest(port, authority, path, { method = "GET", headers = {}, body } = {}) {
  const bodyBytes = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method, path,
      headers: { host: authority, accept: "*/*", connection: "close", ...headers,
        ...(bodyBytes ? { "content-length": String(bodyBytes.length) } : {}) } }, response => {
      const chunks = [];
      let length = 0;
      response.on("data", chunk => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("local Relay response exceeded the bounded body limit"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("end", () => resolveResponse({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.once("error", reject);
    });
    request.setTimeout(15_000, () => request.destroy(Object.assign(new Error("local Relay HTTP request timed out"), { code: "ETIMEDOUT" })));
    request.once("error", reject);
    request.end(bodyBytes ?? undefined);
  });
}

function extractAssets(html, documentUrl) {
  const rows = [];
  for (const tagMatch of html.matchAll(/<(?:link|script)\b[^>]*>/gi)) {
    const tag = tagMatch[0];
    const link = /^<link\b/i.test(tag);
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? "";
    const attribute = link ? "href" : "src";
    const raw = tag.match(new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
    if (!raw || (link && !rel.split(/\s+/).includes("stylesheet"))) continue;
    const url = new URL(raw, documentUrl);
    const kind = /\.css(?:$|[?#])/i.test(url.pathname) ? "css"
      : /\.m?js(?:$|[?#])/i.test(url.pathname) ? "javascript" : null;
    if (!kind) continue;
    const document = new URL(documentUrl);
    assert.equal(url.origin, document.origin, "Mobile CSS and JavaScript stay on the single configured Relay authority");
    assert.ok(url.pathname.startsWith(`${document.pathname}`), "Mobile CSS and JavaScript stay under the selected Gateway mobile mount");
    rows.push({ kind, path: `${url.pathname}${url.search}` });
  }
  return rows;
}

function contentType(headers) {
  return String(headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
}
