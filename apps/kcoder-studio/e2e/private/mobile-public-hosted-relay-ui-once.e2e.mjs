import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, RunContext, runE2E, waitFor } from "../harness/run-context.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { materializeWorkspace } from "../harness/workspace-fixture.mjs";
import { validatePinnedGatewayRuntime } from "../harness/pinned-gateway.mjs";
import { createOwnedSshDispatcher, createSshStageObserver, startOwnedSshControlMaster }
  from "../harness/owned-ssh-control-master.mjs";
import { startOwnedRemoteRelay, validateOwnedRemoteRelayInputs } from "./remote-relay-lifecycle-static03.once.mjs";
import { HOSTED_SIDECAR_PINS, inspectHostedSidecar, installHostedSidecar, restoreHostedSidecar }
  from "./public-hosted-relay-sidecar.once.mjs";

// Private manual once-run. After Root review, from this checkout run:
// timeout --signal=INT --kill-after=360s 480s env \
//   KCODER_E2E_PUBLIC_HOSTED_RELAY_UI_ONCE=1 \
//   KCODER_E2E_PUBLIC_RELAY_FIXTURE_DIR=/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-infra.e2e.mjs/20261007-183008.205Z/state \
//   KCODER_E2E_PUBLIC_SSH_CONFIG=/home/hyf/.ssh/config \
//   KCODER_E2E_PUBLIC_SSH_KNOWN_HOSTS=/home/hyf/.ssh/known_hosts \
//   node apps/kcoder-studio/e2e/private/mobile-public-hosted-relay-ui-once.e2e.mjs
// Active wall budget is 480s; SIGINT opens a 360s cleanup grace (hard maximum 840s).
// The exact sidecar restoration callback is bounded by 180s; its recovery context uses 150s.
// SSH target defaults to the already-reviewed `aliyun` alias. Never place credential values in this file or its artifacts.

const ENABLE = "KCODER_E2E_PUBLIC_HOSTED_RELAY_UI_ONCE";
assert.equal(process.env[ENABLE], "1", `set ${ENABLE}=1 to explicitly run this private live once-test`);
assert.equal(process.version, "v22.17.0", "use the reviewed Node runtime");

const fixtureRoot = resolve(required("KCODER_E2E_PUBLIC_RELAY_FIXTURE_DIR"));
const sshConfig = resolve(required("KCODER_E2E_PUBLIC_SSH_CONFIG"));
const sshKnownHosts = resolve(required("KCODER_E2E_PUBLIC_SSH_KNOWN_HOSTS"));
const sshTarget = process.env.KCODER_E2E_PUBLIC_SSH_TARGET || "aliyun";
assert.match(sshTarget, /^[a-zA-Z0-9_.-]+(?:@[a-zA-Z0-9_.-]+)?$/);
assert.equal(fixtureRoot, "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-infra.e2e.mjs/20261007-183008.205Z/state");
assert.equal(sshConfig, "/home/hyf/.ssh/config");
assert.equal(sshKnownHosts, "/home/hyf/.ssh/known_hosts");

const origin = "https://hyf2333.top";
const proofRoot = resolve(repoRoot, "target/private-phone-ux-validation/b2-static03-build-20261008");
const binary = resolve(proofRoot, "frozen-candidate/kcoder");
const binarySha256 = "289618f7e0670be9840b48adcd93d73261ea1c20034596ae6a95d5ed41f3b67d";
const binaryBytes = 465185944;
const gatewayPins = Object.freeze({
  snapshotRelativePath: "target/private-phone-ux-implementation/render-profile-gateway-runtime-c22-20261009",
  expectedManifestSha256: "474ea99288424030dddcba6a63f47689e8dd7f24c18ca5a9e21bb78c6262c39b",
  expectedSourceTreeSha256: "02f803a6da08b5e6ee0915ed35da295b2cfd84548ff8c09d3ba67016233f0e24",
  expectedDependencyTreeSha256: "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954",
  expectedDevServerSha256: "da5fb47f82597f03ecdbdd41f6b9f3ab357b6006b6792ecc375c18e7de08c218",
  expectedBinaryPath: "target/private-phone-ux-validation/b2-static03-build-20261008/frozen-candidate/kcoder",
  expectedBinarySha256: binarySha256,
  expectedNodeVersion: "v22.17.0",
});
const static04Root = resolve(repoRoot, "target/private-phone-ux-implementation/gateway-hosted-mobile-web-20261009/candidate-static04/source");
const static04ManifestPath = resolve(repoRoot, "target/private-phone-ux-implementation/gateway-hosted-mobile-web-20261009/candidate-static04/manifest.json");
const static04ManifestSha256 = "5455d0ef0f4aceb82e6d0ee74cdf15df354d7e8704e696b4ea8f747db84a7a2d";
const hostedOverlayPins = Object.freeze({
  "apps/kcoder-studio/dev-server.mjs": {
    beforeSha256: "da5fb47f82597f03ecdbdd41f6b9f3ab357b6006b6792ecc375c18e7de08c218",
    sha256: "0e08d5d2d4dc450673550c5256c53a07bfff9cd4669e8b02ed7276555d9d9b52",
  },
  "apps/kcoder-studio/src/mobile-web-static.js": {
    beforeSha256: null,
    sha256: "b52c71913c346f8072a921a237a6f9f547af85fd8ca88aeeea01a73e5eeb710b",
  },
});
const mobileUiSourcePins = Object.freeze([
  { path: "apps/kcoder-studio/mobile/src/app/welcome.tsx", sha256: "221ddd9a5fdca0efcd59174f6b79aab3fa0430777132f004c517d8e2470555fd",
    needles: ["welcome-direct-connection", "gateway-endpoint", "gateway-token", "gateway-connect"], static04: true },
  { path: "apps/kcoder-studio/mobile/src/app/h/[profileId]/index.tsx", sha256: "dc057f0ddeead084264114b4d87b8e0f868f4acea333b13442b6be8f5fa6a4e5",
    needles: ["new-workspace-${server.id}", "StatusDot status={status}"], static04: false },
  { path: "apps/kcoder-studio/mobile/src/app/new.tsx", sha256: "c0d91a4b99aa462006c75146666afce21a663b646c0f9b3b59df7409cfe908ba",
    needles: ["testID=\"workspace-path\"", "testID=\"model-selector\""], static04: false },
  { path: "apps/kcoder-studio/mobile/src/components/ui.tsx", sha256: "416e0471daeea9883073aa794b6df936bdbbfa24ba56219225a51c5a3817b32f",
    needles: ["accessibilityLabel={status}", "status: \"online\""], static04: false },
]);
const mobileExportEntry = "_expo/static/js/web/entry-ff1e705a081634c061ef78eaf54bbdb2.js";
const exportRoot = resolve(repoRoot, "target/private-phone-ux-implementation/gateway-hosted-mobile-web-20261009/deployment-web-export-02");
const exportManifestSha256 = "6de07d010e0c61956a0cfb4e30d337841f341ccfc5c2bb212017d7bf7eb5b37a";
const exportResourceCount = 37;
const relayRoot = resolve(repoRoot, "apps/kcoder-relay");
const relayPoolManifestPath = resolve(repoRoot, "target/private-phone-ux-implementation/relay-grant-get-pool-20261009/candidate-static03/manifest.json");
const relayPoolOverlayRoot = resolve(repoRoot, "target/private-phone-ux-implementation/relay-grant-get-pool-20261009/candidate-static03/source");
const relayPoolManifestSha256 = "0a4378e704a2f9bd86d4cef268e91041aa68d6765547901581bcf01c25669bfe";
const relayPoolServerBeforeSha256 = "056ffb05f50bba9fe2fc2cada50c29b7d292a6c1ad21b58895f8fe63516661a4";
const relayPoolServerAfterSha256 = "9d0846a54a1062355c95723eab57e4a12942333a4c7fe17cbbb998f1b5a4067a";
const relayPoolHelperSha256 = "1ac7a3e9806c0e57a86300497139d34be9c6143d68d1b18f57e49ba72742c923";
const relayWsVersion = "8.22.0";
const relayWsTreeSha256 = "82fda3fce45378d4be16230987eaf1eb07617c437c29e0e9da524209d6f55e6f";
const chromePath = "/opt/cft/chrome-linux64/chrome";
const chromePin = Object.freeze({
  bytes: 290614600,
  sha256: "0b20b130e7edd9dd51873be867761295fe0cfad490c2b9a64f95bd3cfc08fa71",
  version: "151.0.7922.34",
});
const sshOptions = ["-F", sshConfig, "-o", `UserKnownHostsFile=${sshKnownHosts}`, "-o", "StrictHostKeyChecking=yes",
  "-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=15"];
const serverId = "mobile-real-rust";

let remoteCallOrdinal = 0;
await runE2E(import.meta.url, {
  testId: "mobile-public-hosted-relay-real-rust-ui-once",
  tier: "manual-live",
  retainSuccessLogs: true,
  modelPolicy: "one public HTTPS Mobile Web load, UI pairing, Home and New action over one hostname through the owned Relay to an isolated Gateway and fixed Rust app-server; Gateway runtime is frozen C22 with the two exact static04 hosting source overlays; no Provider call, model turn, physical-phone or throughput claim",
  bodyAbortTimeoutMs: 15_000,
  cleanupTimeoutMs: 180_000,
}, async context => {
  const fixtureInfo = await inspectPrivateRoot(fixtureRoot);
  await Promise.all([sshConfig, sshKnownHosts, proofRoot, static04Root, static04ManifestPath, exportRoot,
    relayRoot, relayPoolManifestPath, relayPoolOverlayRoot]
    .map(path => noSymlinkPath(path)));
  assert.equal(fixtureInfo.uid, process.getuid());
  assert.equal(fixtureInfo.mode, 0o700);

  const fixtures = await privateJson(join(fixtureRoot, "private-mobile-pairing-fixtures.json"));
  const registry = await privateJson(join(fixtureRoot, "relay-registration-store.json"));
  const identity = await privateJson(join(fixtureRoot, "relay-client-alpha.json"));
  const fixture = fixtures.alpha;
  assert.match(fixture?.id || "", /^[a-f0-9]{32}$/);
  assert.match(fixture?.pairingToken || "", /^[A-Za-z0-9._~-]{32,512}$/);
  assert.match(identity?.secret || "", /^[A-Za-z0-9._~-]{32,512}$/);
  const registryEntry = registry.gateways?.find(row => row.id === fixture.id);
  assert.ok(registryEntry && registryEntry.id === identity.id && registryEntry.secret === identity.secret &&
    registryEntry.pairingToken === fixture.pairingToken, "private Relay registration and UI pairing fixtures must match");
  context.registerSecret(fixture.id);
  context.registerSecret(fixture.pairingToken);
  context.registerSecret(identity.secret);
  for (const row of registry.gateways) for (const secret of [row.id, row.secret, row.pairingToken]) {
    if (typeof secret === "string") context.registerSecret(secret);
  }

  // Validate every immutable input before any remote route change.
  const gatewayRuntime = await validatePinnedGatewayRuntime(gatewayPins);
  const rustBinaryPin = await filePin(binary);
  assert.equal(rustBinaryPin.sha256, binarySha256);
  assert.equal(rustBinaryPin.bytes, binaryBytes);
  const chrome = await filePin(chromePath);
  assert.deepEqual(chrome, { bytes: chromePin.bytes, sha256: chromePin.sha256 });
  const static04 = await verifyHostedStaticInputs();
  const relayInputPins = await verifyRelayPoolInputs();
  const remoteRelayRuntimePins = await validateOwnedRemoteRelayInputs({
    relayRoot, poolManifestPath: relayPoolManifestPath, poolOverlayRoot: relayPoolOverlayRoot,
  });
  assert.equal(remoteRelayRuntimePins.supportLivePinCount, 14);
  assert.equal(remoteRelayRuntimePins.getPoolHelperCount, 1);
  assert.equal(remoteRelayRuntimePins.relaySourceCount, 13);
  assert.equal(remoteRelayRuntimePins.wsFileCount, 19);

  const gatewayRoot = context.pathInState("fixed-c22-gateway-static04-hosting-overlay");
  context.registerTemporaryDirectory("owned hosted Gateway source overlay", gatewayRoot);
  await cp(gatewayRuntime.root, gatewayRoot, {
    recursive: true,
    filter: source => resolve(source) !== resolve(gatewayRuntime.root, "node_modules"),
  });
  await chmodOwnedTree(gatewayRoot);
  await rm(join(gatewayRoot, "gateway-runtime-freeze.json"));
  await symlink(await realpath(join(gatewayRuntime.root, "node_modules")), join(gatewayRoot, "node_modules"), "dir");
  const executedHostedOverlay = await applyHostedStatic04Overlay(gatewayRoot, static04);

  const webRoot = context.pathInState("owned-mobile-web-export-static04");
  context.registerTemporaryDirectory("owned Mobile Web bundle", webRoot);
  await cp(exportRoot, webRoot, { recursive: true });
  assert.deepEqual((await listFiles(webRoot)).sort(), static04.exportPaths,
    "owned static Mobile Web export must be exactly the 37 pinned resources and manifest");
  for (const row of static04.exportManifest.files) {
    assert.deepEqual(await filePin(join(webRoot, row.path)), { bytes: row.size, sha256: row.sha256 });
  }

  const workspace = await materializeWorkspace(context, "minimal", { instanceId: "public-mobile-real-rust" });
  const configRoot = context.pathInState("gateway-config");
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  const settingsFile = await context.writeStateJson("gateway-config/settings.json", {
    hooks: {}, active_provider: "once-no-call", providers: {
      "once-no-call": { api_format: "openai_chat_completions", endpoint: "http://127.0.0.1:9/v1",
        default_model: "once-no-call", context_window_tokens: 8192, output_headroom_tokens: 1024,
        max_output_tokens: 1024, discover_models: false, no_proxy: true },
    },
  });
  const dummyKey = "public-hosted-ui-no-provider-call";
  context.registerSecret(dummyKey);
  await context.writeStateJson("gateway-config/credentials.json", { "once-no-call": { type: "api", key: dummyKey } });
  const serversFile = await context.writeStateJson("servers.json", [{ id: serverId, label: "Fixed real Rust",
    runtime: "kcoder", transport: "local", command: binary, workspacePath: workspace.path, settingsFile }]);
  const selectedStore = { version: registry.version, gateways: [registryEntry] };
  const registrationStoreFile = await context.writeStateJson("relay-registration-store.json", selectedStore);
  const publicGatewayBase = `${origin}/g/${fixture.id}`;
  const workspacePath = workspace.path;

  const managedSsh = await startOwnedSshControlMaster(context, {
    binary: "/usr/bin/ssh", target: sshTarget, configPath: sshConfig,
    knownHostsPath: sshKnownHosts, cwd: repoRoot,
  });
  const dispatcher = createOwnedSshDispatcher({ primaryContext: context, managedTransport: managedSsh,
    binary: "/usr/bin/ssh", target: sshTarget, directOptions: sshOptions });
  context.spawnRemoteSsh = (label, command, options) => dispatcher.spawn(context, label, command, options);

  const original = { configPath: HOSTED_SIDECAR_PINS.originalConfigPath,
    configSha256: HOSTED_SIDECAR_PINS.originalConfigSha256, pid: HOSTED_SIDECAR_PINS.expectedOriginalPid,
    argv: ["/usr/bin/caddy", "run", "--config", HOSTED_SIDECAR_PINS.originalConfigPath, "--adapter", "caddyfile"] };
  const remoteBefore = await inspectHostedSidecar(context, remoteOutput);
  original.startTicks = remoteBefore.remote.sidecar.startTicks;
  const transactionHash = createHash("sha256").update(context.seed).digest("hex").slice(0, 24);
  const transaction = {
    marker: `kc_route_${transactionHash}`,
    root: `/tmp/kc-phone-ux-rust-baseline-${transactionHash}`,
    gatewayId: fixture.id,
    original,
    configPath: `/tmp/kc-phone-ux-rust-baseline-${transactionHash}/isolated-443-front.Caddyfile`,
    pidPath: `/tmp/kc-phone-ux-rust-baseline-${transactionHash}/candidate.pid`,
    logPath: `/tmp/kc-phone-ux-rust-baseline-${transactionHash}/candidate.log`,
    originalPidPath: `/tmp/kc-phone-ux-rust-baseline-${transactionHash}/original-restored.pid`,
    staticRootSha256: remoteBefore.staticRoot.treeSha256,
    productionArgvSha256: remoteBefore.remote.productionOwners[0].argvSha256,
    productionStartTicks: remoteBefore.remote.productionOwners[0].startTicks,
    candidateSha256: null, candidatePid: null, candidateStartRequested: false,
  };
  const recovery = await RunContext.create(import.meta.url, {
    testId: "mobile-public-hosted-relay-ui-once-recovery", tier: "manual-live",
    retainSuccessLogs: true, cleanupTimeoutMs: 150_000,
  });
  for (const secret of [fixture.id, fixture.pairingToken, identity.secret]) recovery.registerSecret(secret);
  dispatcher.attachRecoveryContext(recovery);
  recovery.spawnRemoteSsh = (label, command, options) => dispatcher.spawn(recovery, label, command, options);
  context.addCleanup("restore exact test 443 owner and remove root-owned candidate", async () => {
    let failure = null;
    try {
      const restored = await restoreHostedSidecar(recovery, transaction, remoteBefore, {
        repoRoot, sshOptions, sshTarget, remoteOutput, waitFor,
      });
      assert.equal(restored.rootRemoval, "confirmed-absent");
      assert.deepEqual(restored.staticRoot, remoteBefore.staticRoot);
      assert.equal(restored.remote.productionListenerSha256, remoteBefore.remote.productionListenerSha256);
      const productionOwnerProjection = ({ pid, exe, euid, argvConfigMatch, argvSha256 }) =>
        ({ pid, exe, euid, argvConfigMatch, argvSha256 });
      assert.deepEqual(restored.remote.productionOwners.map(productionOwnerProjection),
        remoteBefore.remote.productionOwners.map(productionOwnerProjection));
      await recovery.writeArtifactJsonInternal("hosted-sidecar-restoration-evidence.json", restored);
    } catch (error) { failure = error; }
    try { await recovery.finish(failure ? "failed" : "passed", { parentRunRoot: context.runRoot }, failure); }
    catch (finishError) { failure ??= finishError; }
    if (failure) throw failure;
  });

  const gateway = await startGateway(context, {
    label: "fixed-c22-hosted-gateway", auth: true, authToken: fixture.pairingToken,
    gatewayRoot, cwd: gatewayRoot, workspace: workspace.path, serversFile,
    serversStore: context.pathInState("servers-store.json"), kcoderBin: binary,
    allowedHosts: "hyf2333.top,127.0.0.1,localhost,::1",
    env: {
      KCODER_STUDIO_MOCK: "0",
      KCODER_STUDIO_PUBLIC_ORIGINS: origin,
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: origin,
      KCODER_STUDIO_MOBILE_WEB_ROOT: webRoot,
      KCODER_STUDIO_WEB_ROOT: context.pathInState("unused-desktop-web-root"),
      KCODER_STUDIO_SECURE_COOKIE: "1",
      KCODER_CONFIG_DIR: configRoot,
      KCODER_HOME: context.pathInState("isolated-kcoder-home"),
    },
  });
  assert.equal(gateway.scriptPath, join(gatewayRoot, "dev-server.mjs"));
  assert.equal(gateway.child.spawnfile, process.execPath);
  assert.equal(gateway.child.spawnargs.at(-1), gateway.scriptPath);
  await context.writeArtifactJson("fixed-runtime-overlay-pins.json", {
    runtimeBasis: "fixed C22 source/dependency snapshot plus the two hosted static04 product source overlays; not a claim of a live full-backend source snapshot",
    gateway: { manifestSha256: gatewayRuntime.manifestSha256, sourceTreeSha256: gatewayRuntime.sourceTreeSha256,
      dependencyTreeSha256: gatewayRuntime.dependencyTreeSha256, baseDevServerSha256: gatewayPins.expectedDevServerSha256,
      hostedStatic04Overlay: executedHostedOverlay, mock: false, rustBinarySha256: binarySha256 },
    mobileWebExport: { manifestSha256: exportManifestSha256, resources: exportResourceCount },
    relay: { ...relayInputPins, runtimeProjection: remoteRelayRuntimePins },
    chromium: { executablePath: chromePath, ...chromePin, noSandbox: true },
  });

  await installHostedSidecar(context, transaction, remoteBefore, {
    remoteOutput, sshTransport: managedSsh, repoRoot, waitFor,
  });
  const relay = await startOwnedRemoteRelay({
    context, recoveryContext: recovery, remoteOutput, sshWrite, sshTransport: managedSsh,
    relayRoot, poolManifestPath: relayPoolManifestPath, poolOverlayRoot: relayPoolOverlayRoot,
    registrationStoreFile, gatewayId: fixture.id, serverId, workspacePath,
    sharedHost: new URL(origin).host,
  });
  const identityFile = await context.writeStateJson("relay-client-alpha.json", { ...identity, relayOrigin: origin });
  const { startRegisteredClient } = await import(pathToFileURL(join(relayRoot, "src/client.mjs")).href);
  let relayClientOnline = false;
  const client = await startRegisteredClient({
    url: origin, pairingToken: fixture.pairingToken, identityFile,
    gateway: gateway.baseUrl, onOnline: () => { relayClientOnline = true; },
  });
  context.addCleanup("close selected public Relay client", () => client.close());
  await waitFor(() => relayClientOnline, 20_000, "selected Relay client online over the single public HTTPS hostname", 50, context.abortSignal);

  const browserHarness = await startChromium(context, {
    label: "public-hosted-relay-mobile-chromium", executablePath: chromePath, noSandbox: true,
  });
  assert.equal(browserHarness.executablePath, chromePath);
  assert.equal(browserHarness.child.spawnfile, chromePath);
  const browserVersion = await browserHarness.browser.version();
  assert.equal(browserVersion, chromePin.version);
  const page = await browserHarness.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const mount = `/g/${fixture.id}/mobile`;
  const mountBase = `${origin}${mount}`;
  const mobileEntryPath = `/g/${fixture.id}/mobile-entry`;
  const mobileEntryUrl = `${origin}${mobileEntryPath}`;
  const expectedMobileUrl = `${mountBase}/`;
  const responses = [];
  const entryResponses = [];
  const entryRequestFailures = [];
  const browserNetworkFailures = [];
  let pairingPost = null;
  let outsideHostnameRequests = 0;
  let pageErrorCount = 0;
  let consoleErrorCount = 0;
  const publicHost = new URL(origin).host;
  const diagnosticScreenshotPath = context.pathInArtifacts("public-hosted-mobile-browser-diagnostic.png");
  const diagnosticSensitiveValues = [fixture.id, fixture.pairingToken, identity.secret, publicGatewayBase];
  page.on("request", request => {
    let parsed;
    try { parsed = new URL(request.url()); } catch { return; }
    if (parsed.host !== publicHost || !["https:", "wss:"].includes(parsed.protocol)) outsideHostnameRequests += 1;
    if (parsed.origin === origin && parsed.pathname === `/g/${fixture.id}/api/mobile/session` && request.method() === "POST") {
      pairingPost = { method: request.method(), path: parsed.pathname };
    }
  });
  page.on("response", response => {
    let parsed;
    try { parsed = new URL(response.url()); } catch { return; }
    if (parsed.origin !== origin) return;
    if (parsed.pathname === mobileEntryPath) {
      if (entryResponses.length >= 8) return;
      const status = response.status();
      entryResponses.push({ status,
        contentType: response.headers()["content-type"]?.split(";", 1)[0] ?? "unknown",
        failureReason: status >= 400 ? safeHttpFailureReason(status) : null });
      return;
    }
    if (responses.length >= 128 || !parsed.pathname.startsWith(mount)) return;
    const path = parsed.pathname;
    const kind = path === `${mount}/` || path === `${mount}/index.html` ? "html"
      : path.endsWith(".js") ? "js" : path.endsWith(".css") ? "css" : null;
    if (!kind) return;
    responses.push({ kind, status: response.status(), contentType: response.headers()["content-type"]?.split(";", 1)[0] ?? "unknown" });
  });
  page.on("requestfailed", request => {
    if (entryRequestFailures.length >= 8) return;
    let parsed;
    try { parsed = new URL(request.url()); } catch { return; }
    if (parsed.origin !== origin || parsed.pathname !== mobileEntryPath) return;
    entryRequestFailures.push({ failureReason: safeBrowserFailureReason(request.failure()?.errorText) });
  });
  page.on("requestfailed", request => {
    if (browserNetworkFailures.length >= 32) return;
    let parsed;
    try { parsed = new URL(request.url()); } catch { return; }
    browserNetworkFailures.push({
      originClass: parsed.origin === origin ? "public" : "outside",
      resourceKind: safeMobileResourceKind(parsed.pathname, mount),
      failureReason: safeBrowserFailureReason(request.failure()?.errorText),
    });
  });
  page.on("pageerror", () => { pageErrorCount += 1; });
  page.on("console", message => { if (message.type() === "error") consoleErrorCount += 1; });
  context.addCleanup("write safe public Mobile entry response evidence", async () => {
    await context.writeArtifactJsonInternal("public-hosted-mobile-entry-response.json", {
      responses: entryResponses, requestFailures: entryRequestFailures,
    });
  });
  context.addCleanup("write safe hosted Mobile browser diagnostics", async () => {
    let domSummary = { available: false, failureReason: "page_closed" };
    let screenshotCaptured = false;
    let screenshotFailureReason = "page_closed";
    if (!page.isClosed()) {
      try {
        domSummary = await maskAndSummarizeBrowserPage(page, diagnosticSensitiveValues);
      } catch {
        domSummary = { available: false, failureReason: "safe_dom_capture_failed" };
        screenshotFailureReason = "safe_dom_capture_failed";
      }
      if (domSummary.available && !page.isClosed()) {
        try {
          await page.screenshot({ path: diagnosticScreenshotPath, fullPage: false, animations: "disabled", timeout: 5_000,
            mask: [page.locator("input,textarea,[contenteditable='true']")], maskColor: "#000000" });
          screenshotCaptured = true;
          screenshotFailureReason = null;
        } catch {
          screenshotFailureReason = "screenshot_failed";
        }
      }
    }
    await context.writeArtifactJsonInternal("public-hosted-mobile-browser-diagnostics.json", {
      assetResponses: responses.map(({ kind, status, contentType }) => ({ kind, status, contentType })),
      assetResponseCount: responses.length,
      entryResponses,
      entryRequestFailures,
      outsideHostnameRequests,
      networkFailures: browserNetworkFailures,
      pageErrorCount,
      consoleErrorCount,
      domSummary,
      screenshot: { captured: screenshotCaptured,
        artifact: screenshotCaptured ? "public-hosted-mobile-browser-diagnostic.png" : null,
        failureReason: screenshotFailureReason },
    });
  });
  const entryResponse = await page.goto(mobileEntryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  assert.equal(entryResponse?.status(), 200, "public HTTPS /mobile-entry must return the hosted Mobile Web endpoint");
  const entry = await entryResponse.json();
  const entryUrls = [entry?.mobileUrl, entry?.gatewayUrl];
  const entryCredentialFree = entryUrls.every(value => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && parsed.host === publicHost && !parsed.username && !parsed.password &&
      !parsed.search && !parsed.hash && !value.includes(fixture.pairingToken) && !value.includes(identity.secret);
    } catch { return false; }
  }) && JSON.stringify(Object.keys(entry ?? {}).sort()) === JSON.stringify(["available", "gatewayUrl", "mobileUrl", "version"]);
  assert.equal(entry?.version, 1);
  assert.equal(entry?.available, true);
  assert.equal(entry?.mobileUrl, expectedMobileUrl);
  assert.equal(entry?.gatewayUrl, publicGatewayBase);
  assert.equal(entryCredentialFree, true, "public /mobile-entry URLs must carry no credential material");
  const documentResponse = await page.goto(expectedMobileUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  assert.equal(documentResponse?.status(), 200, "public Relay-mounted Mobile Web document must load over HTTPS");
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  assert.ok(responses.some(row => row.kind === "html" && row.status === 200 && row.contentType === "text/html"),
    "HTML must come from the public HTTPS request, without route fulfillment");
  assert.ok(responses.some(row => row.kind === "js" && row.status === 200 && row.contentType === "application/javascript"),
    "JavaScript must come from the public HTTPS request, without route fulfillment");
  assert.ok(responses.some(row => row.kind === "css" && row.status === 200 && row.contentType === "text/css"),
    "CSS must come from the public HTTPS request, without route fulfillment");

  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("gateway-endpoint").fill(publicGatewayBase);
  await page.getByTestId("gateway-token").fill(fixture.pairingToken);
  const pairResponsePromise = page.waitForResponse(response => {
    const request = response.request();
    try { return new URL(response.url()).pathname === `/g/${fixture.id}/api/mobile/session` && request.method() === "POST"; }
    catch { return false; }
  }, { timeout: 30_000 });
  await page.getByTestId("gateway-connect").click();
  const pairResponse = await pairResponsePromise;
  assert.equal(pairResponse.status(), 200, "Mobile UI pairing must complete through public Relay to the selected Gateway");
  await page.waitForURL(/\/h\/[^/?#]+(?:\/|$)/, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="online"]').length > 0,
    undefined, { timeout: 30_000 });
  const newButton = page.getByTestId(`new-workspace-${serverId}`);
  await newButton.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await newButton.isEnabled(), true, "Home must offer the selected fixed Rust server");
  await newButton.click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("model-selector").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(outsideHostnameRequests, 0, "all browser requests must stay on the one secure public hostname");
  assert.deepEqual(pairingPost, { method: "POST", path: `/g/${fixture.id}/api/mobile/session` });

  const rustChild = await proveRustChild(context, gateway.child.pid, binary, binarySha256);
  await context.writeArtifactJson("public-hosted-mobile-ui-evidence.json", {
    status: "PASS",
    host: new URL(origin).host,
    route: "public HTTPS Relay mount -> isolated Gateway -> fixed Rust app-server",
    mobileEntry: { status: entryResponse.status(), available: entry.available === true,
      exactMobileUrl: entry.mobileUrl === expectedMobileUrl, exactGatewayUrl: entry.gatewayUrl === publicGatewayBase,
      credentialFree: entryCredentialFree },
    mobileSelectorSources: static04.selectorSources,
    staticAssets: responses,
    pairing: { method: pairingPost.method, status: pairResponse.status(), path: pairingPost.path,
      tokenEnteredInUi: true, credentialValuesRecorded: false },
    home: { onlineIndicatorVisible: true, selectedServerId: serverId },
    new: { clicked: true, workspacePathVisible: true, modelSelectorVisible: true, modelActionTriggered: false },
    browser: { executableSha256: chromePin.sha256, version: browserVersion, outsideHostnameRequests },
    gateway: { mock: false, sourceBasis: "C22 frozen source/dependency pin plus static04 hosted-source overlay", rustChild },
    relay: { manifestSha256: relayPoolManifestSha256, supportLivePinCount: 14,
      serverBeforeSha256: relayPoolServerBeforeSha256, serverAfterSha256: relayPoolServerAfterSha256,
      getPoolHelperSha256: relayPoolHelperSha256, receipt: relay.receipt },
    claims: { providerCall: false, modelTurn: false, physicalPhone: false, throughput: false,
      liveFullBackendSourceSnapshot: false },
  });
});

async function verifyHostedStaticInputs() {
  const bytes = await readFile(static04ManifestPath);
  assert.equal(sha256(bytes), static04ManifestSha256, "static04 source manifest changed");
  const manifest = JSON.parse(bytes.toString("utf8"));
  const rows = new Map(manifest.files.map(row => [row.path, row]));
  assert.equal(manifest.files.length, 15);
  for (const [path, expected] of Object.entries(hostedOverlayPins)) {
    const row = rows.get(path);
    assert.ok(row, `static04 must include ${path}`);
    assert.equal(row.beforeSha256, expected.beforeSha256);
    assert.equal(row.sha256, expected.sha256);
    assert.deepEqual(await filePin(resolve(static04Root, path)), { bytes: row.size, sha256: row.sha256 });
  }
  const selectorSources = [];
  for (const source of mobileUiSourcePins) {
    const expectedSha256 = source.static04 ? rows.get(source.path)?.sha256 : source.sha256;
    assert.equal(expectedSha256, source.sha256, `static04 Mobile UI selector source pin changed: ${source.path}`);
    const sourcePath = source.static04 ? resolve(static04Root, source.path) : resolve(repoRoot, source.path);
    const sourceBytes = await readFile(sourcePath);
    assert.equal(sha256(sourceBytes), source.sha256, `Mobile UI selector source changed: ${source.path}`);
    const sourceText = sourceBytes.toString("utf8");
    for (const needle of source.needles) assert.ok(sourceText.includes(needle), `selector source no longer defines ${needle}`);
    selectorSources.push({ path: source.path, sha256: source.sha256 });
  }
  const exportManifestBytes = await readFile(join(exportRoot, "kcoder-mobile-web.json"));
  assert.equal(sha256(exportManifestBytes), exportManifestSha256);
  const exportManifest = JSON.parse(exportManifestBytes.toString("utf8"));
  assert.equal(exportManifest.files.length, exportResourceCount);
  for (const row of exportManifest.files) assert.deepEqual(await filePin(join(exportRoot, row.path)), { bytes: row.size, sha256: row.sha256 });
  const exportedEntry = await readFile(join(exportRoot, mobileExportEntry), "utf8");
  for (const selector of ["welcome-direct-connection", "gateway-endpoint", "gateway-token", "gateway-connect",
    "new-workspace-", "workspace-path", "model-selector", "aria-label", "online"]) {
    assert.ok(exportedEntry.includes(selector), `pinned exported Mobile Web JavaScript lacks ${selector}`);
  }
  const exportPaths = ["kcoder-mobile-web.json", ...exportManifest.files.map(row => row.path)].sort();
  assert.deepEqual((await listFiles(exportRoot)).sort(), exportPaths);
  return { manifest, rows, exportManifest, exportPaths, selectorSources };
}

async function applyHostedStatic04Overlay(gatewayRoot, static04) {
  const applied = {};
  for (const [sourcePath, expected] of Object.entries(hostedOverlayPins)) {
    const row = static04.rows.get(sourcePath);
    assert.equal(row.beforeSha256, expected.beforeSha256);
    const destination = join(gatewayRoot, sourcePath.slice("apps/kcoder-studio/".length));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await chmod(destination, 0o600).catch(error => { if (error.code !== "ENOENT") throw error; });
    await cp(resolve(static04Root, sourcePath), destination);
    await chmod(destination, 0o600);
    assert.deepEqual(await filePin(destination), { bytes: row.size, sha256: row.sha256 });
    applied[sourcePath] = { beforeSha256: row.beforeSha256, afterSha256: row.sha256 };
  }
  return applied;
}

async function verifyRelayPoolInputs() {
  const bytes = await readFile(relayPoolManifestPath);
  assert.equal(sha256(bytes), relayPoolManifestSha256);
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(manifest.revision, "static03");
  assert.equal(manifest.supportLivePins.length, 14);
  assert.equal(manifest.files.length, 2);
  const support = new Map(manifest.supportLivePins.map(row => [row.path, row]));
  const overlays = new Map(manifest.files.map(row => [row.path, row]));
  assert.equal(support.get("apps/kcoder-relay/src/server.mjs")?.sha256, relayPoolServerBeforeSha256);
  assert.equal(overlays.get("apps/kcoder-relay/src/server.mjs")?.before, relayPoolServerBeforeSha256);
  assert.equal(overlays.get("apps/kcoder-relay/src/server.mjs")?.after, relayPoolServerAfterSha256);
  assert.equal(overlays.get("apps/kcoder-relay/src/http-get-pool.mjs")?.before, null);
  assert.equal(overlays.get("apps/kcoder-relay/src/http-get-pool.mjs")?.after, relayPoolHelperSha256);
  const lock = JSON.parse(await readFile(join(relayRoot, "package-lock.json"), "utf8"));
  assert.equal(lock.packages?.["node_modules/ws"]?.version, relayWsVersion);
  assert.equal(sha256(await readFile(join(relayRoot, "src/server.mjs"))), relayPoolServerAfterSha256);
  assert.equal(sha256(await readFile(join(relayRoot, "src/http-get-pool.mjs"))), relayPoolHelperSha256);
  assert.equal(sha256(await readFile(join(relayPoolOverlayRoot, "apps/kcoder-relay/src/server.mjs"))), relayPoolServerAfterSha256);
  assert.equal(sha256(await readFile(join(relayPoolOverlayRoot, "apps/kcoder-relay/src/http-get-pool.mjs"))), relayPoolHelperSha256);
  const supportPins = [];
  for (const row of manifest.supportLivePins) {
    const path = row.path.slice("apps/kcoder-relay/".length);
    const actual = await filePin(join(relayRoot, path));
    assert.equal(actual.bytes, overlays.get(row.path)?.size ?? row.size);
    assert.equal(actual.sha256, path === "src/server.mjs" ? relayPoolServerAfterSha256 : row.sha256,
      `complete committed Relay support closure changed at ${path}`);
    supportPins.push({ path: row.path, sha256: actual.sha256 });
  }
  assert.equal(supportPins.length, 14);
  return { manifestSha256: relayPoolManifestSha256, supportPins, supportLivePinCount: 14,
    serverBeforeSha256: relayPoolServerBeforeSha256, serverAfterSha256: relayPoolServerAfterSha256,
    getPoolHelperSha256: relayPoolHelperSha256, wsVersion: relayWsVersion, wsTreeSha256: relayWsTreeSha256 };
}

async function remoteOutput(context, label, command, timeoutMs = 30_000) {
  const result = await runRemote(context, label, command, { timeoutMs, maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 64 * 1024 });
  await writeRemoteStageEvidence(context, label, result.stage);
  return result.stdout.toString("utf8").trimEnd();
}

async function sshWrite(context, label, command, bytes) {
  const result = await runRemote(context, label, command, { timeoutMs: 30_000, maxStdoutBytes: 8192, maxStderrBytes: 32 * 1024, stdin: bytes });
  await writeRemoteStageEvidence(context, label, result.stage);
  assert.equal(result.stdout.length, 0, "private remote write must not echo submitted bytes");
}

async function runRemote(context, label, command, {
  timeoutMs, maxStdoutBytes, maxStderrBytes, stdin,
}) {
  const callId = String(++remoteCallOrdinal).padStart(4, "0");
  const safeLabel = String(label).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 72) || "remote";
  const processLabel = `ssh-${callId}-${safeLabel}`;
  const observer = createSshStageObserver(performance.now());
  const child = await context.spawnRemoteSsh(processLabel, command, {
    cwd: repoRoot, env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
    ...(stdin === undefined ? {} : { stdin: "pipe" }),
  });
  let closeInfo = null, spawnFailure = false;
  const stdout = [], stderr = [];
  let stdoutBytes = 0, stderrBytes = 0, overflow = false, stopPromise = null;
  const stop = () => stopPromise ??= context.stopOwned(processLabel);
  child.once("error", () => { spawnFailure = true; });
  child.once("close", (code, signal) => { closeInfo = { code, signal }; });
  child.stdout.on("data", chunk => {
    const bytes = Buffer.from(chunk); stdoutBytes += bytes.length;
    if (stdoutBytes > maxStdoutBytes) { overflow = true; void stop().catch(() => {}); return; }
    stdout.push(bytes);
  });
  child.stderr.on("data", chunk => {
    const bytes = Buffer.from(chunk); stderrBytes += bytes.length;
    if (stderrBytes > maxStderrBytes) { overflow = true; void stop().catch(() => {}); return; }
    stderr.push(bytes); observer.push(bytes);
  });
  if (stdin !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(stdin); }
  try {
    await waitFor(() => closeInfo !== null || spawnFailure, timeoutMs, `owned SSH operation ${safeLabel}`, 25, context.abortSignal);
  } catch (error) {
    await stop().catch(() => {});
    throw new Error(`owned SSH operation did not complete: ${safeLabel}`, { cause: error });
  }
  const stage = observer.finish();
  const output = Buffer.concat(stdout);
  const expectsPythonMarkers = command.includes("KCUX_STAGE:REMOTE_PYTHON_ENTERED");
  const expectedStages = expectsPythonMarkers ? ["REMOTE_PYTHON_ENTERED", "REMOTE_PROGRAM_COMPLETE"] : [];
  assert.equal(closeInfo?.code, 0, `owned SSH operation failed: ${safeLabel}`);
  assert.equal(closeInfo?.signal, null);
  assert.equal(spawnFailure, false);
  assert.equal(overflow, false);
  assert.equal(stage.valid, true);
  assert.deepEqual(stage.markers.map(row => row.stage), expectedStages);
  return { stdout: output, stderrBytes, stage };
}

async function writeRemoteStageEvidence(context, label, stage) {
  const id = String(remoteCallOrdinal).padStart(4, "0");
  await context.writeArtifactJson(`ssh-stage-${id}-${String(label).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 56)}.json`, {
    outcome: "completed", markers: stage.markers,
    invalidMarkerCount: stage.invalidMarkerCount, droppedMarkerCount: stage.droppedMarkerCount,
  });
}

async function proveRustChild(context, gatewayPid, expectedBinary, expectedSha256) {
  const rows = [];
  for (const name of await readdir("/proc")) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const text = await readFile(`/proc/${name}/stat`, "utf8");
      rows.push({ pid: Number(name), parent: Number(text.slice(text.lastIndexOf(")") + 2).split(" ")[1]) });
    } catch {}
  }
  const descendants = new Set([gatewayPid]);
  for (let index = 0; index < rows.length; index += 1) for (const row of rows) {
    if (descendants.has(row.parent)) descendants.add(row.pid);
  }
  const matches = [];
  const expectedReal = await realpath(expectedBinary);
  for (const pid of descendants) if (pid !== gatewayPid) {
    try { if (await realpath(`/proc/${pid}/exe`) === expectedReal) matches.push(pid); } catch {}
  }
  assert.equal(matches.length, 1, "fixed Gateway must own exactly one fixed Rust app-server child");
  const actual = await stat(`/proc/${matches[0]}/exe`), pinned = await stat(expectedBinary);
  assert.deepEqual({ dev: actual.dev, ino: actual.ino, size: actual.size },
    { dev: pinned.dev, ino: pinned.ino, size: binaryBytes });
  assert.equal((await filePin(expectedBinary)).sha256, expectedSha256);
  return { gatewayPid, appServerPid: matches[0], executableSha256: expectedSha256, mock: false };
}

async function privateJson(path) {
  await noSymlinkPath(path);
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o777, 0o600);
  assert.ok(info.size > 0 && info.size <= 256 * 1024);
  return JSON.parse(await readFile(path, "utf8"));
}

async function inspectPrivateRoot(path) {
  await noSymlinkPath(path);
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  return { uid: info.uid, mode: info.mode & 0o777 };
}

async function noSymlinkPath(path) {
  let current = "/";
  for (const component of resolve(path).split("/").filter(Boolean)) {
    current = resolve(current, component);
    assert.equal((await lstat(current)).isSymbolicLink(), false, "pinned paths may not traverse symlinks");
  }
}

async function filePin(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `pinned file is not regular: ${path}`);
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function listFiles(root, prefix = "") {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.equal(entry.isSymbolicLink(), false, "pinned export must not contain symlinks");
    if (entry.isDirectory()) paths.push(...await listFiles(join(root, entry.name), name));
    else if (entry.isFile()) paths.push(name);
    else assert.fail("pinned export contains a special file");
  }
  return paths;
}

async function chmodOwnedTree(root) {
  const info = await lstat(root);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await chmodOwnedTree(path);
    else if (entry.isFile()) await chmod(path, 0o600);
    else assert.fail("owned runtime contains a special file");
  }
}

function required(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.length > 0, `missing required environment variable ${name}`);
  return value;
}

function safeHttpFailureReason(status) {
  return Number.isInteger(status) && status >= 400 ? `http_status_${status}` : null;
}

function safeBrowserFailureReason(errorText) {
  const match = /^net::(ERR_[A-Z0-9_]+)$/.exec(String(errorText ?? ""));
  return match ? match[1] : "request_failed";
}

function safeMobileResourceKind(pathname, mount) {
  if (pathname === `${mount}/` || pathname === `${mount}/index.html`) return "html";
  if (pathname.endsWith(".js")) return "js";
  if (pathname.endsWith(".css")) return "css";
  if (pathname.endsWith("/mobile-entry")) return "entry";
  return "other";
}

async function maskAndSummarizeBrowserPage(page, sensitiveValues) {
  return page.evaluate(values => {
    const sensitive = values.filter(value => typeof value === "string" && value.length >= 8);
    const maskText = value => {
      let text = String(value ?? "");
      for (const secret of sensitive) text = text.split(secret).join("[redacted]");
      return text
        .replace(/([?&](?:token|secret|access_token|refresh_token)=)[^&#\s]*/gi, "$1[redacted]")
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,512}/gi, "[redacted-authorization]")
        .replace(/\/g\/[A-Za-z0-9_-]{16,64}/g, "/g/[redacted]")
        .replace(/\b[A-Za-z0-9._~-]{48,512}\b/g, "[redacted-opaque]");
    };
    const fields = [...document.querySelectorAll("input,textarea,[contenteditable='true']")];
    const visibleFieldKinds = fields.filter(field => field.getClientRects().length > 0).slice(0, 16)
      .map(field => field.tagName.toLowerCase() === "textarea" ? "textarea" :
        field.tagName.toLowerCase() === "input" ? `input:${field.type || "text"}` : "contenteditable");
    const style = document.createElement("style");
    style.textContent = "input,textarea,[contenteditable='true']{visibility:hidden!important;color:transparent!important;text-shadow:none!important;caret-color:transparent!important}";
    document.head?.append(style);
    for (const field of fields) field.style.setProperty("visibility", "hidden", "important");
    if (document.body) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) node.textContent = maskText(node.textContent);
    }
    document.title = maskText(document.title);
    return {
      available: true,
      title: maskText(document.title).slice(0, 160),
      visibleText: maskText(document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 1600),
      visibleInputCount: visibleFieldKinds.length,
      visibleInputKinds: visibleFieldKinds,
    };
  }, sensitiveValues);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
