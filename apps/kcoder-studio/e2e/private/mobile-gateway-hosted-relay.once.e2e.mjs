import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { appRoot, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { materializeWorkspace } from "../harness/workspace-fixture.mjs";
import { validatePinnedGatewayRuntime } from "../harness/pinned-gateway.mjs";

const GATEWAY_SNAPSHOT = "target/private-phone-ux-implementation/render-profile-gateway-runtime-c22-20261009";
const GATEWAY_MANIFEST_SHA = "474ea99288424030dddcba6a63f47689e8dd7f24c18ca5a9e21bb78c6262c39b";
const GATEWAY_SOURCE_SHA = "02f803a6da08b5e6ee0915ed35da295b2cfd84548ff8c09d3ba67016233f0e24";
const GATEWAY_DEPENDENCY_SHA = "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954";
const GATEWAY_BASE_SERVER_SHA = "da5fb47f82597f03ecdbdd41f6b9f3ab357b6006b6792ecc375c18e7de08c218";
const BINARY_PATH = "target/private-phone-ux-validation/b2-static03-build-20261008/frozen-candidate/kcoder";
const BINARY_SHA = "289618f7e0670be9840b48adcd93d73261ea1c20034596ae6a95d5ed41f3b67d";
const STATIC_ROOT = resolve(repoRoot, "target/private-phone-ux-implementation/gateway-hosted-mobile-web-20261009/candidate-static04/source");
const STATIC_MANIFEST = resolve(repoRoot, "target/private-phone-ux-implementation/gateway-hosted-mobile-web-20261009/candidate-static04/manifest.json");
const STATIC_MANIFEST_SHA = "5455d0ef0f4aceb82e6d0ee74cdf15df354d7e8704e696b4ea8f747db84a7a2d";
const EXPORT_ROOT = resolve(repoRoot, "target/private-phone-ux-implementation/gateway-hosted-mobile-web-20261009/deployment-web-export-02");
const EXPORT_MANIFEST_SHA = "6de07d010e0c61956a0cfb4e30d337841f341ccfc5c2bb212017d7bf7eb5b37a";
const EXPORT_FILE_COUNT = 37;
const RELAY_SOURCE = resolve(repoRoot, "apps/kcoder-relay");
const RELAY_ORIGIN_HELPER = [
  "apps/kcoder-studio/dev-server.mjs",
  "apps/kcoder-studio/src/mobile-web-static.js",
  "apps/kcoder-relay/src/server.mjs",
  "apps/kcoder-relay/src/pair.mjs",
];

assert.equal(process.env.KCODER_E2E_GATEWAY_HOSTED_RELAY_ONCE, "1", "set the private hosting diagnostic flag");
assert.equal(process.version, "v22.17.0", "use the reviewed Node runtime");

await runE2E(import.meta.url, {
  testId: "mobile-gateway-hosted-relay-static-entry",
  tier: "manual-live",
  retainSuccessLogs: true,
  modelPolicy: "one real Relay-mounted Mobile Web static route through an isolated KCODER_STUDIO_MOCK Gateway; no Provider, turn, direct route, or second Gateway",
  cleanupTimeoutMs: 30_000,
}, async context => {
  const evidence = { state: "running", scope: "single registered Gateway; actual Relay HTTP path; no route.fulfill", nodeVersion: process.version, requests: { html200: false, js200: false, css200: false }, entry: { status: null, available: false, exactUrls: false, containsCredential: null } };
  context.addCleanup("write hosted Relay evidence", () => context.writeArtifactJsonInternal("mobile-gateway-hosted-relay.json", evidence));
  const runtime = await validatePinnedGatewayRuntime({
    snapshotRelativePath: GATEWAY_SNAPSHOT, expectedManifestSha256: GATEWAY_MANIFEST_SHA,
    expectedSourceTreeSha256: GATEWAY_SOURCE_SHA, expectedDependencyTreeSha256: GATEWAY_DEPENDENCY_SHA,
    expectedDevServerSha256: GATEWAY_BASE_SERVER_SHA, expectedBinaryPath: BINARY_PATH,
    expectedBinarySha256: BINARY_SHA, expectedNodeVersion: "v22.17.0",
  });
  const staticManifestBytes = await readFile(STATIC_MANIFEST);
  assert.equal(sha256(staticManifestBytes), STATIC_MANIFEST_SHA);
  const staticManifest = JSON.parse(staticManifestBytes);
  const staticRows = new Map(staticManifest.files.map(row => [row.path, row]));
  for (const row of staticManifest.files) assert.deepEqual(await filePin(resolve(STATIC_ROOT, row.path)), { bytes: row.size, sha256: row.sha256 });
  const exportBytes = await readFile(join(EXPORT_ROOT, "kcoder-mobile-web.json"));
  assert.equal(sha256(exportBytes), EXPORT_MANIFEST_SHA);
  const exportManifest = JSON.parse(exportBytes);
  assert.equal(exportManifest.files.length, EXPORT_FILE_COUNT);
  const expectedFiles = ["kcoder-mobile-web.json", ...exportManifest.files.map(row => row.path)].sort();
  for (const row of exportManifest.files) assert.deepEqual(await filePin(resolve(EXPORT_ROOT, row.path)), { bytes: row.size, sha256: row.sha256 });
  assert.deepEqual((await listFiles(EXPORT_ROOT)).sort(), expectedFiles, "deployment export contains exactly its pinned 37 resources plus manifest");

  const gatewayRoot = context.pathInState("owned-gateway-runtime");
  context.registerTemporaryDirectory("owned Gateway runtime", gatewayRoot);
  const freeze = JSON.parse(await readFile(join(runtime.root, "gateway-runtime-freeze.json"), "utf8"));
  await cp(runtime.root, gatewayRoot, { recursive: true, filter: source => resolve(source) !== resolve(runtime.root, "node_modules") });
  await chmodOwnedTree(gatewayRoot);
  await rm(join(gatewayRoot, "gateway-runtime-freeze.json"));
  await symlink(await realpath(join(runtime.root, "node_modules")), join(gatewayRoot, "node_modules"), "dir");
  const relayRoot = context.pathInState("owned-relay-runtime");
  context.registerTemporaryDirectory("owned Relay runtime", relayRoot);
  await cp(join(RELAY_SOURCE, "src"), join(relayRoot, "src"), { recursive: true });
  await symlink(await realpath(join(RELAY_SOURCE, "node_modules")), join(relayRoot, "node_modules"), "dir");
  for (const path of RELAY_ORIGIN_HELPER) {
    const row = staticRows.get(path);
    assert.ok(row, "static04 overlay source is pinned");
    const destination = path.startsWith("apps/kcoder-studio/")
      ? join(gatewayRoot, path.slice("apps/kcoder-studio/".length))
      : join(relayRoot, "src", path.slice("apps/kcoder-relay/src/".length));
    await mkdir(dirname(destination), { recursive: true });
    await chmod(destination, 0o600).catch(error => { if (error.code !== "ENOENT") throw error; });
    await copyFile(resolve(STATIC_ROOT, path), destination);
    await chmod(destination, 0o600);
    assert.equal(sha256(await readFile(destination)), row.sha256);
  }
  const webRoot = context.pathInState("owned-mobile-web-root");
  context.registerTemporaryDirectory("owned Mobile Web export", webRoot);
  await cp(EXPORT_ROOT, webRoot, { recursive: true });
  evidence.inputs = { gatewayManifestSha256: runtime.manifestSha256, gatewaySourceSha256: runtime.sourceTreeSha256, gatewayDependencySha256: runtime.dependencyTreeSha256, static04ManifestSha256: STATIC_MANIFEST_SHA, exportManifestSha256: EXPORT_MANIFEST_SHA, exportFiles: EXPORT_FILE_COUNT, c22SourceFiles: freeze.sourceFiles.length };
  await context.writeArtifactJson("hosting-inputs.json", evidence.inputs);

  const workspace = await materializeWorkspace(context, "minimal", { instanceId: "gateway-hosted-relay" });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "mobile-smoke",
    label: "Mobile smoke",
    runtime: "kcoder",
    transport: "local",
    command: runtime.binaryPath,
    workspace: workspace.path,
  }]);
  const publicHostPort = await unusedPort();
  const relayAuthority = "127.0.0.1:" + publicHostPort;
  const relayOrigin = "http://" + relayAuthority;
  const registrationKey = randomBytes(32).toString("base64url");
  const pairingToken = randomBytes(32).toString("base64url");
  context.registerSecret(registrationKey);
  context.registerSecret(pairingToken);
  const storeFile = await context.writeStateJson("relay-registration-store.json", { version: 1, gateways: [] });
  const relayModule = await import(pathToFileURL(join(relayRoot, "src/server.mjs")).href);
  const relay = await relayModule.startRelay({ gateways: [], sharedHosts: [relayAuthority], registrationKey, registrationStoreFile: storeFile, controlPort: 0, proxyPort: publicHostPort });
  context.registerPort("hosted-mobile-relay-control", relay.controlPort);
  context.registerPort("hosted-mobile-relay-public", relay.proxyPort);
  context.addCleanup("close owned Relay", () => relay.close());
  assert.equal(relay.proxyPort, publicHostPort);

  const gateway = await startGateway(context, {
    label: "hosted-mobile-gateway", gatewayRoot, cwd: gatewayRoot, workspace: workspace.path, serversFile,
    serversStore: context.pathInState("servers-store.json"), kcoderBin: runtime.binaryPath,
    authToken: pairingToken, allowedHosts: "127.0.0.1,localhost," + relayAuthority,
    env: { KCODER_STUDIO_MOCK: "1", KCODER_HOME: context.pathInState("gateway-home"), KCODER_STUDIO_MOBILE_WEB_ROOT: webRoot, KCODER_STUDIO_PUBLIC_ORIGINS: relayOrigin, KCODER_STUDIO_MOBILE_WEB_ORIGINS: relayOrigin },
  });
  const clientModule = await import(pathToFileURL(join(relayRoot, "src/client.mjs")).href);
  let online = false;
  const client = await clientModule.startRegisteredClient({
    url: "http://127.0.0.1:" + relay.controlPort, registrationKey, pairingToken,
    identityFile: context.pathInState("relay-client-identity.json"), gateway: gateway.baseUrl,
    allowInsecure: true, retryMs: 500, onOnline: () => { online = true; },
  });
  context.addCleanup("stop registered Relay client", () => client.close());
  await waitFor(() => online, 10_000, "registered Gateway control channel online", 25, context.abortSignal);
  const identity = JSON.parse(await readFile(context.pathInState("relay-client-identity.json"), "utf8"));
  assert.match(identity.id, /^[a-f0-9]{32}$/);
  for (const value of [identity.id, identity.secret, identity.enrollmentToken].filter(Boolean)) context.registerSecret(value);
  evidence.gatewayRegistered = true;

  const browser = await startChromium(context, { label: "hosted-mobile-chromium", noSandbox: true, executablePath: "/opt/cft/chrome-linux64/chrome" });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const prefix = "/g/" + identity.id + "/mobile";
  const routes = [];
  page.on("response", response => {
    if (routes.length >= 64) return;
    const path = new URL(response.url()).pathname;
    if (!path.startsWith(prefix)) return;
    const kind = path.endsWith(".js") ? "js" : path.endsWith(".css") ? "css" : (path === prefix + "/" || path === prefix + "/index.html") ? "html" : null;
    if (kind) routes.push({ kind, status: response.status() });
  });
  const documentResponse = await page.goto(relayOrigin + prefix + "/", { waitUntil: "domcontentloaded", timeout: 20_000 });
  assert.equal(documentResponse?.status(), 200, "Relay-mounted Mobile Web document returns HTTP 200");
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  evidence.requests = {
    html200: routes.some(row => row.kind === "html" && row.status === 200),
    js200: routes.some(row => row.kind === "js" && row.status === 200),
    css200: routes.some(row => row.kind === "css" && row.status === 200),
    routeResponses: routes,
  };
  assert.ok(evidence.requests.html200 && evidence.requests.js200 && evidence.requests.css200, "HTML, JavaScript, and CSS were loaded over the actual Relay/Gateway route");
  const entry = await page.evaluate(async path => {
    const response = await fetch(path);
    return { status: response.status, body: await response.json() };
  }, prefix.slice(0, prefix.lastIndexOf("/mobile")) + "/mobile-entry");
  evidence.entry = {
    status: entry.status, available: entry.body.available === true,
    exactUrls: entry.body.version === 1 && entry.body.mobileUrl === relayOrigin + prefix + "/" && entry.body.gatewayUrl === relayOrigin + prefix.slice(0, prefix.lastIndexOf("/mobile")),
    containsCredential: Object.keys(entry.body).some(key => /token|secret|credential/i.test(key)),
  };
  assert.equal(entry.status, 200);
  assert.equal(evidence.entry.available, true);
  assert.equal(evidence.entry.exactUrls, true);
  assert.equal(evidence.entry.containsCredential, false);
  evidence.state = "PASS";
});

async function filePin(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "pinned input is a regular file");
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function chmodOwnedTree(root) {
  const info = await lstat(root);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), "owned Gateway root is a real directory");
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await chmodOwnedTree(path);
    else if (entry.isFile()) await chmod(path, 0o600);
    else assert.fail("owned Gateway tree contains a special file");
  }
}

async function listFiles(root, prefix = "") {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = prefix ? prefix + "/" + entry.name : entry.name;
    assert.equal(entry.isSymbolicLink(), false, "export contains no symlinks");
    if (entry.isDirectory()) paths.push(...await listFiles(join(root, entry.name), path));
    else if (entry.isFile()) paths.push(path);
    else assert.fail("export contains a special file");
  }
  return paths;
}

async function unusedPort() {
  const server = await import("node:net").then(({ createServer }) => createServer());
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
