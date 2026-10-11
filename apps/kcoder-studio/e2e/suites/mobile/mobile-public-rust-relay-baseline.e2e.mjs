import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appRoot, repoRoot, RunContext, runE2E, waitFor } from "../../harness/run-context.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { validatePinnedGatewayRuntime } from "../../harness/pinned-gateway.mjs";
import { restoreRoutesOnlySidecarOnce } from "../../harness/single-ssh-sidecar-restore.mjs";
import { stopAndWaitForOriginalSidecarOnce } from "../../harness/single-ssh-sidecar-stop-wait.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { createNewCatalogProbePage, loadFrozenMobileWebBundle } from "../../private/mobile-public-new-catalog-dom-probe.candidate.mjs";
import { loadVerifiedMobileHomeWaterfallInputs, runMobileHomeWaterfallCandidate }
  from "../../private/mobile-public-home-waterfall-336-339.candidate.mjs";
import { closeRpcAndWait, initializeRpc, openRpc } from "../../private/rpc-ws-diagnostic.mjs";
import { createBoundedRelayDiagnosticCollector } from "../../harness/public-relay-diagnostics.mjs";
import { startOwnedRemoteRelay } from "../../harness/remote-relay-lifecycle.mjs";
import { buildMarkedPythonSource, createOwnedSshDispatcher, createSshStageObserver, startOwnedSshControlMaster }
  from "../../harness/owned-ssh-control-master.mjs";
import { buildRoutesOnlySidecarCandidate, removeRoutesOnlyMarker } from "./routes-only-sidecar-config.candidate.mjs";

// Explicit manual-live entry: one bounded Browser diagnostic; no Provider, model turn, build or production configuration write.
assert.equal(process.env.KCODER_E2E_PUBLIC_RUST_RELAY_BASELINE, "1", "public baseline requires explicit enable");
assert.equal(process.version, "v22.17.0", "use the reviewed Node runtime");
const preflightFlag = process.env.KCODER_E2E_PUBLIC_RUST_RELAY_PREFLIGHT_ONLY;
assert.ok(preflightFlag === undefined || preflightFlag === "0" || preflightFlag === "1",
  "read-only preflight flag must be unset, 0, or 1");
const readOnlyPreflight = preflightFlag === "1";
const frozenGatewayFlag = process.env.KCODER_E2E_PUBLIC_FROZEN_C22_GATEWAY;
assert.ok(frozenGatewayFlag === undefined || frozenGatewayFlag === "0" || frozenGatewayFlag === "1",
  "frozen C22 Gateway flag must be unset, 0, or 1");
const runFrozenGateway = frozenGatewayFlag === "1";
const waterfallFlag = process.env.KCODER_E2E_PUBLIC_HOME_WATERFALL;
assert.ok(waterfallFlag === undefined || waterfallFlag === "0" || waterfallFlag === "1",
  "336/339 waterfall mode must be unset, 0, or 1");
const runHomeWaterfall = waterfallFlag === "1";
assert.ok(!runFrozenGateway || (runHomeWaterfall && !readOnlyPreflight),
  "the frozen C22 Gateway mode is only for the active matched Home/Sessions waterfall");
const fixtureRoot = resolve(required("KCODER_E2E_PUBLIC_RELAY_FIXTURE_DIR"));
const relayRoot = resolve(required("KCODER_E2E_RELAY_RUNTIME_ROOT"));
const pinnedRelayRuntimeRoot = resolve(repoRoot, "target/private-phone-ux-implementation/relay-eof-drain-20261009/controlled-run-01/runtime");
const sshTarget = process.env.KCODER_E2E_PUBLIC_SSH_TARGET || "aliyun";
assert.match(sshTarget, /^[a-zA-Z0-9_.-]+(?:@[a-zA-Z0-9_.-]+)?$/);
const sshConfig = resolve(required("KCODER_E2E_PUBLIC_SSH_CONFIG"));
const sshKnownHosts = resolve(required("KCODER_E2E_PUBLIC_SSH_KNOWN_HOSTS"));
// This manual-live suite is pinned to the approved existing isolated test front.
assert.equal(fixtureRoot, "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-infra.e2e.mjs/20261007-183008.205Z/state");
assert.equal(relayRoot, pinnedRelayRuntimeRoot);
assert.equal(sshTarget, "aliyun"); assert.equal(sshConfig, "/home/hyf/.ssh/config"); assert.equal(sshKnownHosts, "/home/hyf/.ssh/known_hosts");
const sshOptions = ["-F", sshConfig, "-o", `UserKnownHostsFile=${sshKnownHosts}`, "-o", "StrictHostKeyChecking=yes",
  "-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=15"];
const origin = "https://hyf2333.top";
const sidecarBaseConfigPath = "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile";
const sidecarBaseConfigSha256 = "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c";
const productionConfigPath = "/etc/caddy/Caddyfile";
const productionConfigSha256 = "05f6cab324663aed662c318ff54b30b67fa7ef36299419be63a8ba1bda71a511";
const productionPid = 200738;
const expectedStaticRoot = "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root";
const expectedStaticFiles = 37;
const proofRoot = resolve(repoRoot, "target/private-phone-ux-validation/b2-static03-build-20261008");
const binary = resolve(proofRoot, "frozen-candidate/kcoder");
const binarySha = "289618f7e0670be9840b48adcd93d73261ea1c20034596ae6a95d5ed41f3b67d";
const frozenCftChromePath = "/opt/cft/chrome-linux64/chrome";
const frozenCftChromePin = Object.freeze({
  bytes: 290614600,
  sha256: "0b20b130e7edd9dd51873be867761295fe0cfad490c2b9a64f95bd3cfc08fa71",
  version: "151.0.7922.34",
});
const frozenGatewayPins = Object.freeze({
  snapshotRelativePath: "target/private-phone-ux-implementation/render-profile-gateway-runtime-c22-20261009",
  expectedManifestSha256: "474ea99288424030dddcba6a63f47689e8dd7f24c18ca5a9e21bb78c6262c39b",
  expectedSourceTreeSha256: "02f803a6da08b5e6ee0915ed35da295b2cfd84548ff8c09d3ba67016233f0e24",
  expectedDependencyTreeSha256: "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954",
  expectedDevServerSha256: "da5fb47f82597f03ecdbdd41f6b9f3ab357b6006b6792ecc375c18e7de08c218",
  expectedBinaryPath: "target/private-phone-ux-validation/b2-static03-build-20261008/frozen-candidate/kcoder",
  expectedBinarySha256: binarySha,
  expectedNodeVersion: "v22.17.0",
});
const frozenRelaySourceInventoryPath = resolve(repoRoot,
  "target/private-phone-ux-implementation/relay-eof-drain-20261009/controlled-run-01/unique-controlled-isolation-01/runtime-src-before.sha256");
const frozenRelaySourceInventorySha256 = "613125221bde3478b35d7f00930a9677fc546340d40a0604580a570514108f62";
const frozenRelayPackagePins = Object.freeze({
  "package.json": { bytes: 530, sha256: "9c9899c86c106b0ccbce4c635f6a8df0128559ab5bcedff5ed72cca84db095cb" },
  "package-lock.json": { bytes: 12156, sha256: "f4491ba93c4c858c4d17edacdffa49f2da84f48b4284441cb38d101f1ee591b0" },
});
const sourceDigest = "0a51d82e17ef78d9db034d34143258b49f094d605a2e89e2c2e8498e70ffc15b";
const mobileBundleRoot = resolve(repoRoot, "target/private-phone-ux-implementation/mobile-web-export-new4-geometry-20261008");
const mobileBundleManifest = resolve(repoRoot, "target/private-phone-ux-implementation/mobile-web-export-new4-geometry-20261008-manifest.json");
const mobileBundlePins = Object.freeze({ manifestSha256: "c7c73628bbd9ec3161d3de1df72b3b041ef7095456a6798afcfcc6b999885691",
  sourceTreeSha256: "e0bf097c3e9f052bc0caa038d675b008bf79d6f51b1e2b4d0b632998025dabc6",
  bundleSha256: "eb1350004b826fed1a9ca42e4d66adcf87142f46d8208c3a4b733ce115983785",
  indexHtmlSha256: "a6ac1f6f894c95b6acbb4de15257223883cf544141e1077104f0a9000057255d", fileCount: 37 });
let probeOrdinal = 0;
let remoteCallOrdinal = 0;
let sourceInventoryObservation = null;
const expected = {
  "apps/kcoder-studio/e2e/harness/run-context.mjs": "94f0c27306f8944cbd10f1835227a408c51a0b558981d846832bb297c5e5cf11",
  "apps/kcoder-studio/e2e/harness/gateway.mjs": "7cef55697a767cb78c88dd9c4c72203e9db129e16d8502341e5496d3a325a2c9",
  "apps/kcoder-studio/e2e/harness/pinned-gateway.mjs": "1c3ac598e01ceb02b1dc9c3305e4fae26701a3ff3a68ad516d229517c5fba7a1",
  "apps/kcoder-studio/e2e/harness/public-relay-diagnostics.mjs": "05ac6a39900bc62738d51669c97f762655d325528c8079761c60135f55d4c605",
  "apps/kcoder-studio/e2e/harness/single-ssh-sidecar-restore.mjs": "9783bb8bba15ecb7adfd7f2a665e6c2e82a64b96cf6ef2766ff01cfc841c1b06",
  "apps/kcoder-studio/e2e/harness/owned-ssh-control-master.mjs": "5173fe065619393c1ac9fbd65310066d052f5d2a6e1f04b93d6fd78dba8e8122",
  "apps/kcoder-studio/e2e/harness/owned-ssh-control-master.review.test.mjs": "01e77d3668ef8064830e9341804185edf47738de581787dc502810a07709a014",
  "apps/kcoder-studio/e2e/harness/single-ssh-sidecar-stop-wait.mjs": "19f2a359058ba642c9d4dae856d941aa4786a3372bd9aa098d5421b22120d2cf",
  "apps/kcoder-studio/e2e/harness/single-ssh-sidecar-stop-wait.review.test.mjs": "30b47de9dae5b95db09034ae2722b6f622bae647b126f8d18a7833a8c4e40bc8",
  "apps/kcoder-studio/e2e/suites/mobile/routes-only-sidecar-config.candidate.mjs": "1fd1eabe26a53c50716098e4d24608a3955b1234912187740aa3cd78a768b944",
  "apps/kcoder-studio/e2e/harness/remote-relay-ingress.once.mjs": "2184c60b986ea1de3823d6c8096d20b9fd2c49d37511ebc015dec5131bd61b23",
  "apps/kcoder-studio/e2e/harness/chromium.mjs": "6da43f71496317e00098780ab7e8c3bf0874e4b925c6add4e4c0e87bdf7b504c",
  "apps/kcoder-studio/e2e/private/header-websocket-ws-diagnostic.mjs": "8ad8c60e952a3e00e5c8893e10a27d9d02b50c650675387624abe77c46bbb898",
  "apps/kcoder-studio/e2e/private/rpc-ws-diagnostic.mjs": "31578823aaf3fea2d874ed2004b1d4f54da6476837246f348f10da8802e18c0d",
  "apps/kcoder-studio/e2e/private/mobile-public-new-catalog-dom-probe.candidate.mjs": "301658bf571cdd1b949ed30b8178d98e36c30299491ce8672eae563df456eed8",
  "apps/kcoder-studio/e2e/harness/remote-relay-lifecycle.mjs": "120ce98c8f33930d91d2062c73fefbdde380cf4ea6c605081ed1a4d29cb99631",
  "apps/kcoder-studio/dev-server.mjs": "da5fb47f82597f03ecdbdd41f6b9f3ab357b6006b6792ecc375c18e7de08c218",
  "apps/kcoder-studio/e2e/private/mobile-public-home-waterfall-336-339.candidate.mjs": "3d46ca338b55fd31ec4036529affea14c9b5d06e53fff7233194c91a1722c8d3",
  "apps/kcoder-studio/src/workspace-app-server-broker.js": "de270981df51156abcc4320113f0717fa238b7cdbfbea6027098b711c19ceb59",
  "apps/kcoder-relay/src/server.mjs": "b5f1cbca28a91548330b424abef77e8bdb88d1a0ac0e76c2b8b6d238bcd9e616",
  "apps/kcoder-relay/src/client.mjs": "339d7d85a203d2a6293138c000d0a17aa6bb0de1ae40bb9e524aae0073d988f8",
  "apps/kcoder-relay/src/client-identity.mjs": "c9e22731e4b553b1060f5dc4060de5ff4f37483527ade1a28104741c2500aa7d",
  "apps/kcoder-relay/src/transport.mjs": "6a56287394425ce297a2c87534c739645cd85eb99efc707ffe9d1ce6a8277d7c",
};

await runE2E(import.meta.url, {
  testId: readOnlyPreflight ? "mobile-public-rust-relay-readonly-preflight"
    : runHomeWaterfall ? runFrozenGateway ? "mobile-public-rust-relay-home-waterfall-336-339-c22-n1"
      : "mobile-public-rust-relay-home-waterfall-336-339-preflight"
      : "mobile-public-rust-relay-baseline",
  tier: "manual-live", retainSuccessLogs: true,
  modelPolicy: readOnlyPreflight
    ? "setup-only read-only SSH owner/config/static-root preflight; no route mutation, Gateway, Relay, Browser, or RTT claim"
    : runHomeWaterfall
      ? runFrozenGateway
        ? "one matched A336/B339 Home/Sessions public Mobile Web n=1 waterfall pair over the fixed C22 Rust Gateway and frozen Relay; New-page is after-only and excluded, no UI pairing, Provider, model turn, native, or cellular claim"
        : "one matched A336/B339 Home/Sessions public Mobile Web waterfall pair over the already-owned Rust/Relay/Gateway session; no UI pairing, Provider, model turn, native, or cellular claim"
      : "one harness-seeded Mobile Web B New-page diagnostic over the same public Rust session plus Node read-only baseline; no Provider, model turn, native, or cellular claim",
  cleanupTimeoutMs: 120_000,
}, async context => {
  const suffix = "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-infra.e2e.mjs/20261007-183008.205Z/state";
  assert.ok(fixtureRoot.endsWith(`/${suffix}`), "only the declared private fixture boundary is authorized");
  await noSymlinkPath(fixtureRoot); await noSymlinkPath(relayRoot); await noSymlinkPath(sshConfig); await noSymlinkPath(sshKnownHosts);
  const fixtureInfo = await stat(fixtureRoot); assert.ok(fixtureInfo.isDirectory() && fixtureInfo.uid === process.getuid() && (fixtureInfo.mode & 0o777) === 0o700);
  const executedGatewayRuntime = runFrozenGateway
    ? await validatePinnedGatewayRuntime(frozenGatewayPins) : null;
  const executedRelayRuntime = runFrozenGateway ? await verifyFrozenRelayRuntime() : null;
  const samples = [], phases = [], publicServersFailures = [], collector = createBoundedRelayDiagnosticCollector({
    redactText: value => context.redactText(value), maxEvents: 512, maxBytes: 128 * 1024,
  });
  const websocketTransportDiagnostics = [];
  let mobileUiDiagnostic = { status: "NOT_RUN" };
  let publicServersChannelExpectation = { status: "NOT_RUN" };
  let websocketTransportDiagnosticsDropped = 0;
  const diagnosticStages = new Set(["public-wss-setup", "local-wss-setup"]);
  const diagnosticEvents = new Set([
    "connect_started", "dns_lookup", "tcp_connected", "tls_secure_connect", "socket_error", "socket_close",
    "handshake_write_started", "handshake_write_submitted", "handshake_write_callback", "upgrade_response_bytes",
    "upgrade_response", "upgrade_validation", "open_timeout",
  ]);
  const diagnosticPhases = new Set([
    "connecting", "tls_handshake", "tls_connected", "tcp_connected", "handshake_write", "upgrade_rejected",
    "upgrade_invalid", "open",
  ]);
  const diagnosticErrorKinds = new Set([
    "dns_failure", "dns_retry", "refused", "reset", "timeout", "unreachable", "tls_certificate", "tls_protocol", "tls_handshake", "protocol", "other",
  ]);
  function recordWebSocketTransportDiagnostic(stage, record) {
    if (!diagnosticStages.has(stage) || !record || !diagnosticEvents.has(record.event)) return;
    if (websocketTransportDiagnostics.length >= 128) { websocketTransportDiagnosticsDropped += 1; return; }
    const safe = { stage, event: record.event };
    if (Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0 && record.elapsedMs <= 120_000) safe.elapsedMs = record.elapsedMs;
    if (diagnosticPhases.has(record.phase)) safe.phase = record.phase;
    if (record.event === "connect_started" && ["tcp", "tls"].includes(record.transport)) safe.transport = record.transport;
    if (record.event === "dns_lookup") {
      if (["complete", "error"].includes(record.outcome)) safe.outcome = record.outcome;
      if (record.family === 4 || record.family === 6) safe.family = record.family;
      if (diagnosticErrorKinds.has(record.errorKind)) safe.errorKind = record.errorKind;
    }
    if (record.event === "tls_secure_connect") {
      if (typeof record.authorized === "boolean") safe.authorized = record.authorized;
      if (["h2", "http/1.1", "other", "none"].includes(record.alpn)) safe.alpn = record.alpn;
    }
    if (record.event === "socket_error" && diagnosticErrorKinds.has(record.errorKind)) safe.errorKind = record.errorKind;
    if (record.event === "socket_close") {
      if (typeof record.hadError === "boolean") safe.hadError = record.hadError;
      if (typeof record.handshakeComplete === "boolean") safe.handshakeComplete = record.handshakeComplete;
    }
    if (record.event === "handshake_write_submitted" && typeof record.backpressured === "boolean") safe.backpressured = record.backpressured;
    if (record.event === "handshake_write_callback") {
      if (["complete", "error"].includes(record.outcome)) safe.outcome = record.outcome;
      if (diagnosticErrorKinds.has(record.errorKind)) safe.errorKind = record.errorKind;
    }
    if (record.event === "upgrade_response_bytes" && Number.isSafeInteger(record.firstChunkBytes) && record.firstChunkBytes >= 0) {
      safe.firstChunkBytes = Math.min(record.firstChunkBytes, 1_000_000);
    }
    if (record.event === "upgrade_response" && (record.statusCode === null ||
      (Number.isInteger(record.statusCode) && record.statusCode >= 100 && record.statusCode <= 599))) {
      safe.statusCode = record.statusCode;
      safe.statusParsed = record.statusParsed === true;
    }
    if (record.event === "upgrade_validation") {
      if (["accepted", "rejected"].includes(record.outcome)) safe.outcome = record.outcome;
      if (diagnosticErrorKinds.has(record.errorKind)) safe.errorKind = record.errorKind;
    }
    websocketTransportDiagnostics.push(safe);
  }
  const inventory = await sourceInventory({ readOnlyObservation: readOnlyPreflight,
    executedGatewayRuntime, executedRelayRuntime });
  const binaryBefore = await filePin(binary);
  assert.equal(binaryBefore.sha256, binarySha); assert.equal(binaryBefore.bytes, 465185944);
  const chromiumBefore = runFrozenGateway ? await verifyFrozenCftChrome() : null;
  const archivePath = resolve(proofRoot, "source-archive.json");
  assert.equal(await shaFile(archivePath), "1c3388b58f89e9d4a2dc45ed3fc41a307126f108500e93d2689330f447003789");
  const archive = JSON.parse(await readFile(archivePath, "utf8"));
  assert.equal(archive.sourceDigest, sourceDigest); assert.equal(archive.fileCount, 17);
  for (const row of archive.files) assert.deepEqual(await filePin(resolve(proofRoot, "sources", row.path)), { bytes: row.bytes, sha256: row.sha256 });
  await context.writeArtifactJson("inputs-before.json", { node: process.version, nodeExe: await filePin(process.execPath),
    gatewayRoot: executedGatewayRuntime?.root ?? appRoot, relayRuntimeRoot: relayRoot,
    executedGatewayRuntime, executedRelayRuntime, binary: binaryBefore, chromium: chromiumBefore, sourceDigest,
    archiveScope: "17 captured Rust build inputs; Gateway C22 manifest covers 67 source files and 1,034 dependencies; Relay uses a pinned 12-source runtime projection plus exact archive pins",
    inventory,
    sourceInventoryObservation,
    sshTrust: { config: await filePin(sshConfig), knownHosts: await filePin(sshKnownHosts), mode: "explicit -F and absolute known_hosts; strict checking; read-only borrowed trust" } });
  // Registered first: LIFO cleanup checks drift after all resources have stopped.
  context.addCleanup("source and binary drift verification", async () => {
    const gatewayRuntimeAfter = runFrozenGateway ? await validatePinnedGatewayRuntime(frozenGatewayPins) : null;
    const relayRuntimeAfter = runFrozenGateway ? await verifyFrozenRelayRuntime() : null;
    const after = await sourceInventory({ readOnlyObservation: readOnlyPreflight,
      executedGatewayRuntime: gatewayRuntimeAfter, executedRelayRuntime: relayRuntimeAfter });
    const binaryAfter = await filePin(binary);
    const chromiumAfter = runFrozenGateway ? await verifyFrozenCftChrome() : null;
    await context.writeArtifactJsonInternal("inputs-after.json", { inventory: after, sourceInventoryObservation,
      executedGatewayRuntime: gatewayRuntimeAfter, executedRelayRuntime: relayRuntimeAfter, binary: binaryAfter,
      chromium: chromiumAfter });
    assert.deepEqual(after, inventory, "runtime input bytes changed"); assert.deepEqual(binaryAfter, binaryBefore);
    assert.deepEqual(chromiumAfter, chromiumBefore, "frozen CFT Chromium input changed");
    assert.deepEqual(gatewayRuntimeAfter, executedGatewayRuntime, "executed frozen C22 Gateway runtime changed");
    assert.deepEqual(relayRuntimeAfter, executedRelayRuntime, "executed frozen Relay input changed");
  });
  const fixtures = await privateJson(resolve(fixtureRoot, "private-mobile-pairing-fixtures.json"));
  const registry = await privateJson(resolve(fixtureRoot, "relay-registration-store.json"));
  const identity = await privateJson(resolve(fixtureRoot, "relay-client-alpha.json"));
  const fixture = fixtures.alpha;
  for (const value of [fixture?.id, fixture?.pairingToken, identity?.secret]) if (typeof value === "string") context.registerSecret(value);
  const entry = registry.gateways?.find(row => row.id === fixture?.id);
  assert.match(fixture?.id || "", /^[a-f0-9]{32}$/);
  assert.ok(entry && entry.secret === identity.secret && entry.id === identity.id && entry.pairingToken === fixture.pairingToken,
    "private alpha registry/identity/pairing binding must match");
  assert.match(fixture.pairingToken, /^[A-Za-z0-9._~-]{32,512}$/);
  for (const row of registry.gateways) for (const value of [row.id, row.secret, row.pairingToken]) context.registerSecret(value);
  const managedSsh = await startOwnedSshControlMaster(context, {
    binary: "/usr/bin/ssh", target: sshTarget, configPath: sshConfig, knownHostsPath: sshKnownHosts, cwd: repoRoot,
  });
  const sshDispatcher = createOwnedSshDispatcher({ primaryContext: context, managedTransport: managedSsh,
    binary: "/usr/bin/ssh", target: sshTarget, directOptions: sshOptions });
  context.spawnRemoteSsh = (label, command, options) => sshDispatcher.spawn(context, label, command, options);
  const originalSidecar = { configPath: sidecarBaseConfigPath, configSha256: sidecarBaseConfigSha256, pid: null };
  const remoteBefore = await remoteProbe(context, "remote-before", originalSidecar);
  assert.equal(remoteBefore.forwardFree, true, "32552 must be free before this run");
  // Resolve the current owner only after the remote probe matches the pinned config hash,
  // exact Caddy executable/argv, root euid, and sole port-443 listener.
  originalSidecar.pid = remoteBefore.sidecar.pid;
  const staticRootBefore = await remoteStaticRootProjection(context, "static-root-before", originalSidecar);
  assert.equal(staticRootBefore.fileCount, expectedStaticFiles, "the existing public static root must retain its 37 files before the sidecar candidate");
  if (readOnlyPreflight) {
    const summary = {
      status: "READ_ONLY_SETUP_PREFLIGHT_COMPLETE",
      transport: "one foreground RunContext-owned SSH ControlMaster; two managed read-only remote commands",
      remoteCommands: ["remote-before", "static-root-before"],
      remoteState: {
        sidecar: remoteBefore.sidecar,
        productionOwners: remoteBefore.productionOwners,
        productionListenerSha256: remoteBefore.productionListenerSha256,
        forwardFree: remoteBefore.forwardFree,
      },
      staticRoot: staticRootBefore,
      topology: "SSH is setup management only; business data path is Gateway to remote Relay",
      notPerformed: ["remote root creation", "Caddy or Relay config write", "service stop/restart/reload",
        "route exchange", "port forward", "Gateway/Relay startup", "Browser", "business HTTP/WSS timing", "phone RTT"],
    };
    await context.writeArtifactJson("read-only-public-preflight.json", summary);
    return summary;
  }
  // A separate owned context stays active during parent finalization/abort.
  // Parent RunContext forbids spawning new probes once it is finishing.
  const recovery = await RunContext.create(import.meta.url, { testId: "public-rust-baseline-remote-invariant-cleanup",
    tier: "manual-live", retainSuccessLogs: true, cleanupTimeoutMs: 120_000 });
  recovery.registerSecret(fixture.id);
  sshDispatcher.attachRecoveryContext(recovery);
  recovery.spawnRemoteSsh = (label, command, options) => sshDispatcher.spawn(recovery, label, command, options);
  await context.writeArtifactJson("remote-recovery-owner.json", { runRoot: recovery.runRoot });
  let remoteRelay;
  const routeMarker = `kc_route_${createHash("sha256").update(context.seed).digest("hex").slice(0, 24)}`;
  const candidateRoot = `/tmp/kc-phone-ux-rust-baseline-${createHash("sha256").update(context.seed).digest("hex").slice(0, 24)}`;
  const sidecarTransaction = { marker: routeMarker, root: candidateRoot,
    configPath: `${candidateRoot}/isolated-443-front.Caddyfile`,
    pidPath: `${candidateRoot}/candidate.pid`, logPath: `${candidateRoot}/candidate.log`,
    originalPidPath: `${candidateRoot}/original-restored.pid`,
    original: originalSidecar, staticRootSha256: staticRootBefore.treeSha256,
    candidateSha256: null, candidatePid: null, candidateStartRequested: false };
  context.addCleanup("verify remote invariants and restore test443 sidecar", async () => {
    const failures = [];
    let restoration;
    try {
      restoration = await restoreRoutesOnlySidecar(recovery, sidecarTransaction, remoteBefore);
      const after = restoration.remote;
      const staticRootAfter = restoration.staticRoot;
      await recovery.writeArtifactJson("remote-invariants.json", { before: remoteBefore, after, staticRootBefore, staticRootAfter,
        remoteRelay: remoteRelay?.receipt ?? null, remoteRelayCleanup: remoteRelay?.cleanupReceipt ?? null,
        sidecarRestoration: restoration });
      assert.equal(after.forwardFree, true); assert.equal(after.productionListenerSha256, remoteBefore.productionListenerSha256);
      assert.deepEqual(after.productionOwners, remoteBefore.productionOwners);
      assert.equal(after.sidecar.configSha256, sidecarBaseConfigSha256);
      assert.equal(after.sidecar.exeMatches, true); assert.equal(after.sidecar.euid, 0);
      assert.deepEqual(staticRootAfter, staticRootBefore, "the original 37-file static root must remain byte-identical");
    } catch (failure) { failures.push(failure); }
    const error = failures.length === 0 ? null : failures.length === 1 ? failures[0] : new AggregateError(failures, "public baseline cleanup or restore invariants failed");
    if (error) {
      try { await recovery.writeArtifactJson("remote-cleanup-errors.json", {
        labels: failures.map(failure => recovery.redactText(String(failure?.message ?? failure)).slice(0, 2048)),
      }); } catch {}
    }
    await recovery.finish(error ? "failed" : "passed", { parentRunRoot: context.runRoot }, error);
    if (error) throw error; // Parent cleanup cannot pass when the nested invariant proof failed.
  });
  const workspace = context.pathInState("workspace"), config = context.pathInState("config");
  await mkdir(workspace, { mode: 0o700 }); await mkdir(config, { mode: 0o700 });
  const settingsFile = await context.writeStateJson("config/settings.json", { hooks: {},
    active_provider: "baseline-no-call", providers: { "baseline-no-call": { api_format: "openai_chat_completions",
      endpoint: "http://127.0.0.1:9/v1", default_model: "baseline-no-call", context_window_tokens: 8192,
      output_headroom_tokens: 1024, max_output_tokens: 1024, discover_models: false, no_proxy: true } } });
  const dummyKey = "public-baseline-no-provider-call"; context.registerSecret(dummyKey);
  await context.writeStateJson("config/credentials.json", { "baseline-no-call": { type: "api", key: dummyKey } });
  const serversFile = await context.writeStateJson("servers.json", [{ id: "baseline-local", label: "Owned real Rust",
    runtime: "kcoder", transport: "local", command: binary, workspacePath: workspace, settingsFile }]);
  const gateway = await startGateway(context, { label: "public-rust-gateway", auth: true, authToken: fixture.pairingToken,
    workspace, serversFile, serversStore: context.pathInState("server-store.json"), kcoderBin: binary,
    gatewayRoot: executedGatewayRuntime?.root ?? appRoot, allowedHosts: "hyf2333.top,127.0.0.1,localhost,::1",
    env: { KCODER_STUDIO_MOCK: "0", KCODER_STUDIO_PUBLIC_ORIGINS: origin,
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: origin, KCODER_CONFIG_DIR: config, KCODER_HOME: context.pathInState("home"),
      KCODER_STUDIO_SECURE_COOKIE: "1", KCODER_STUDIO_WEB_ROOT: context.pathInState("unused-web-root") } });
  if (executedGatewayRuntime) {
    assert.equal(gateway.gatewayRoot, executedGatewayRuntime.root);
    assert.equal(gateway.cwd, executedGatewayRuntime.root);
    assert.equal(gateway.scriptPath, resolve(executedGatewayRuntime.root, "dev-server.mjs"));
    assert.equal(gateway.child.spawnfile, process.execPath);
    assert.equal(gateway.child.spawnargs.at(-1), gateway.scriptPath);
    await context.writeArtifactJson("executed-gateway-runtime.json", {
      pid: gateway.child.pid,
      cwd: gateway.cwd,
      scriptPath: gateway.scriptPath,
      scriptSha256: executedGatewayRuntime.scriptSha256,
      gatewayManifestSha256: executedGatewayRuntime.manifestSha256,
      sourceTreeSha256: executedGatewayRuntime.sourceTreeSha256,
      dependencyTreeSha256: executedGatewayRuntime.dependencyTreeSha256,
      rustBinarySha256: executedGatewayRuntime.binarySha256,
      mockMode: false,
      processContract: "RunContext-owned Node child executes the C22 frozen dev-server.mjs from its frozen cwd; KCODER_STUDIO_MOCK=0; the child must spawn the separately pinned Rust binary",
    });
  }
  const { startRelay } = await import(pathToFileURL(resolve(relayRoot, "src/server.mjs")));
  const { startRegisteredClient } = await import(pathToFileURL(resolve(relayRoot, "src/client.mjs")));
  const selectedStore = { version: registry.version, gateways: [entry] };
  assert.equal(selectedStore.gateways.length, 1);
  assert.equal(selectedStore.gateways[0].id, fixture.id);
  const registrationStoreFile = await context.writeStateJson("relay-registration-store.json", selectedStore);
  await installAndStartRoutesOnlySidecar(context, sidecarTransaction, remoteBefore, staticRootBefore, managedSsh);
  remoteRelay = await startOwnedRemoteRelay({ context, recoveryContext: recovery,
    remoteOutput, sshWrite, sshTransport: managedSsh, relayRoot, registrationStoreFile,
    gatewayId: fixture.id, serverId: "baseline-local", workspacePath: workspace, sharedHost: new URL(origin).host });
  // Full-chain intent: control and per-request data upgrades use public TLS and the test-owned remote Relay.
  const identityFile = await context.writeStateJson("relay-client-alpha.json", { ...identity, relayOrigin: origin });
  let online = false;
  const client = await startRegisteredClient({ url: origin, pairingToken: fixture.pairingToken, identityFile,
    gateway: gateway.baseUrl, onOnline: () => { online = true; }, onDiagnostic: collector.push });
  context.addCleanup("close owned registered Relay client", () => client.close());
  await waitFor(() => online, 15_000, "owned Relay client online through public TLS", 25, context.abortSignal);
  const route = `${origin}/g/${fixture.id}`, activeRpcs = new Set();
  let session, revoked = false;
  const writeCleanupRevokeDiagnostic = async value => {
    try { await context.writeArtifactJsonInternal("mobile-session-cleanup-revoke-diagnostic.json", value); } catch {}
  };
  context.addCleanup("revoke owned mobile session", async () => {
    if (!session || revoked) return;
    try {
      await http("cleanup-revoke", `${route}/api/mobile/session`, { method: "DELETE", headers: authHeaders() }, 204);
      revoked = true;
      const sample = samples.at(-1);
      const diagnostic = {
        outcome: "CONFIRMED", attempts: 1, automaticRequestRetry: false,
        expectedStatus: 204, observedStatus: Number.isInteger(sample?.statusCode) ? sample.statusCode : null,
        elapsedMs: Number.isFinite(sample?.elapsedMs) ? sample.elapsedMs : null,
        responseBodyRetained: false,
      };
      await writeCleanupRevokeDiagnostic(diagnostic);
    } catch (cleanupFailure) {
      const sample = samples.at(-1);
      const safeFailure = sample?.stage === "cleanup-revoke" && sample.error === true
        ? sample.failure : safeFailureMetadata(cleanupFailure);
      const diagnostic = {
        outcome: "UNCONFIRMED", attempts: 1, automaticRequestRetry: false,
        expectedStatus: 204, observedStatus: Number.isInteger(sample?.statusCode) ? sample.statusCode : null,
        elapsedMs: Number.isFinite(sample?.elapsedMs) ? sample.elapsedMs : null,
        failure: safeFailure ? {
          errorName: typeof safeFailure.errorName === "string" ? safeFailure.errorName : "OtherError",
          errorCode: typeof safeFailure.errorCode === "string" ? safeFailure.errorCode : null,
          causeCode: typeof safeFailure.causeCode === "string" ? safeFailure.causeCode : null,
        } : { errorName: "OtherError", errorCode: null, causeCode: null },
        responseBodyRetained: false,
      };
      await writeCleanupRevokeDiagnostic(diagnostic);
      throw cleanupFailure;
    }
  });
  context.addCleanup("close owned public and local RPC sockets", async () => {
    const closed = await Promise.allSettled([...activeRpcs].map(rpc => closeRpcAndWait(rpc, "baseline socket")));
    const failures = closed.filter(row => row.status === "rejected"); if (failures.length) throw new Error("baseline RPC cleanup failed");
  });
  try {
    session = await http("public-pair", `${route}/api/mobile/session`, { method: "POST",
      headers: { Origin: origin, "content-type": "application/json" },
      body: JSON.stringify({ token: fixture.pairingToken }) }, 200);
    for (const value of [session?.accessToken, session?.rpcToken, session?.refreshToken, session?.deviceId])
      if (typeof value === "string") context.registerSecret(value);
    assert.ok(typeof session.accessToken === "string" && typeof session.rpcToken === "string", "pairing must issue credentials");
    for (let i = 0; i < 10; i++) {
      let requestStart = null;
      try {
        await http("public-servers", `${route}/api/servers`, { headers: authHeaders() }, 200, {
          onStart: startedAt => {
            const snapshot = collector.snapshot();
            requestStart = { startedAt, eventOffset: snapshot.events.length,
              droppedCount: snapshot.droppedCount, rejectedCount: snapshot.rejectedCount };
          },
          validate: result => assert.ok(result.servers?.some(row => row.id === "baseline-local"),
            "public server discovery must reach the owned Gateway"),
        });
      } catch (failure) {
        const sample = samples.at(-1);
        if (sample?.stage !== "public-servers" || sample.error !== true) throw failure;
        const statusCode = Number.isInteger(sample.statusCode) ? sample.statusCode : null;
        if (statusCode !== 504) throw failure;
        const relaySettlement = requestStart
          ? await settlePublicServers504(requestStart)
          : { status: "UNAVAILABLE", reason: "request-start-unavailable" };
        publicServersFailures.push({ sampleIndex: i + 1, statusCode, elapsedMs: sample.elapsedMs,
          failure: sample.failure ?? null, relaySettlement });
        await context.writeArtifactJsonInternal("public-servers-failures.json", publicServersFailures);
      }
    }
    assert.equal(samples.filter(row => row.stage === "public-servers").length, 10,
      "all ten independent read-only server requests must be attempted");
    const publicRpc = await rpcSetup("public-wss-setup", new URL(`${route.replace("https:", "wss:")}/rpc`));
    await proveRustChild(context, gateway.child.pid);
    await listTen("public-wss-list", publicRpc);
    const channelCount = dataOpens().length;
    const localRpc = await rpcSetup("local-wss-setup", new URL(`${gateway.wsUrl}/rpc`));
    await listTen("local-warm-wss-list", localRpc);
    assert.equal(dataOpens().length, channelCount, "local WSS must not create Relay data channels");
    await closeRpcAndWait(localRpc, "local control"); activeRpcs.delete(localRpc);
    await closeRpcAndWait(publicRpc, "public RPC"); activeRpcs.delete(publicRpc);
    assert.equal(new Set(dataOpens().map(row => row.correlation)).size, dataOpens().length,
      "each observed Relay data open must have a unique opaque correlation");
    publicServersChannelExpectation = publicServersFailures.length === 0
      ? { status: "CHECKED", expected: 12, actual: dataOpens().length }
      : { status: "INCOMPLETE_DUE_TO_PUBLIC_GET_FAILURE", expected: 12, actual: dataOpens().length };
    if (publicServersFailures.length === 0) {
      assert.equal(dataOpens().length, 12, "POST + ten GET + one WSS must use twelve Relay channels before Mobile UI");
    }

    const browserOptions = { label: "public-rust-mobile-new-dom-chromium", noSandbox: true };
    if (runFrozenGateway) browserOptions.executablePath = frozenCftChromePath;
    const browserHarness = await startChromium(context, browserOptions);
    if (runFrozenGateway) {
      const actualVersion = await browserHarness.browser.version();
      assert.equal(browserHarness.executablePath, frozenCftChromePath, "frozen waterfall must launch the pinned CFT executable");
      assert.equal(browserHarness.child.spawnfile, frozenCftChromePath, "owned Chromium process must use the pinned CFT executable");
      assert.equal(actualVersion, frozenCftChromePin.version, "running Browser must report the pinned CFT version");
      await context.writeArtifactJson("chromium-runtime-pin.json", {
        executablePath: browserHarness.executablePath,
        bytes: chromiumBefore.bytes,
        sha256: chromiumBefore.sha256,
        version: actualVersion,
        pid: browserHarness.child.pid,
        noSandbox: browserHarness.noSandbox,
      });
    }
    if (runHomeWaterfall) {
      mobileUiDiagnostic = { status: "RUNNING", phase: "preflight", pairCount: 1,
        variants: ["A", "B"], profileSetup: "same already-paired Node session seeded into fresh in-memory BrowserContexts; not UI pairing" };
      try {
        const inputs = await loadVerifiedMobileHomeWaterfallInputs();
        const result = await runMobileHomeWaterfallCandidate({
          runContext: context,
          browser: browserHarness.browser,
          storageState: seededLegacyMobileStorageState(session, route, context.seed),
          gatewayBaseUrl: route,
          serverId: "baseline-local",
          workspacePath: workspace,
          rpcToken: session.rpcToken,
          bundleA: inputs.bundleA,
          bundleB: inputs.bundleB,
          verifiedInputPins: inputs.verifiedInputPins,
          phase: "preflight",
        });
        mobileUiDiagnostic = { status: result.status, phase: result.phase, pairCount: result.pairCount,
          sampleCountPerVariant: result.sampleCountPerVariant,
          profileSetup: "same already-paired Node session seeded into fresh in-memory BrowserContexts; not UI pairing",
          backendWarmth: "public preflight and RPC phase completed before the Mobile pair; backend is warm",
          result };
        await context.writeArtifactJsonInternal("mobile-home-waterfall-336-339-preflight.json", mobileUiDiagnostic);
        assert.equal(result.status, "COMPLETED", "matched 336/339 waterfall pair must complete all UI and network gates");
      } catch (failure) {
        if (mobileUiDiagnostic.status === "RUNNING") mobileUiDiagnostic = {
          ...mobileUiDiagnostic, status: "ERROR", failure: safeFailureMetadata(failure),
        };
        await context.writeArtifactJsonInternal("mobile-home-waterfall-336-339-preflight.json", mobileUiDiagnostic).catch(() => undefined);
        throw failure;
      }
    } else {
      // Fixed B diagnostic: reuse the one Node-paired legacy session in memory; no UI pairing.
      const manifestSha256 = await shaFile(mobileBundleManifest);
      assert.equal(manifestSha256, mobileBundlePins.manifestSha256);
      const bundle = await loadFrozenMobileWebBundle(mobileBundleRoot, mobileBundleManifest);
      assert.equal(bundle.sourceTreeSha256, mobileBundlePins.sourceTreeSha256);
      assert.equal(bundle.bundleSha256, mobileBundlePins.bundleSha256);
      assert.equal(bundle.indexHtmlSha256, mobileBundlePins.indexHtmlSha256);
      assert.equal(bundle.bundleFileCount, mobileBundlePins.fileCount);
      let mobileProbe;
      mobileUiDiagnostic = { status: "RUNNING", sampleCount: 1, variant: "B" };
      try {
        mobileProbe = await createNewCatalogProbePage({ runContext: context, browser: browserHarness.browser,
          storageState: seededLegacyMobileStorageState(session, route, context.seed), bundle,
          variant: "B", pageId: "new-B-sample-01", gatewayBaseUrl: route, serverId: "baseline-local" });
        await mobileProbe.openHome();
        const result = await mobileProbe.clickNewAndWaitForUsableDom();
        mobileUiDiagnostic = {
          status: result.outcome === "COMPLETED" ? "COMPLETED" : result.domOutcome === "COMPLETED" ? "DOM_ONLY_NONPASS" : "ERROR",
          sampleCount: 1, variant: "B", profileSetup: "harness-seeded in-memory storageState from the already paired legacy session; not UI pairing",
          ...result,
        };
        await context.writeArtifactJsonInternal("mobile-new-dom-diagnostic.json", mobileUiDiagnostic);
        assert.equal(result.outcome, "COMPLETED", "zero action RPC or boundary-unknown attribution is not a passing online Mobile diagnostic");
      } catch (failure) {
        if (mobileUiDiagnostic.status === "RUNNING") {
          const homeBootstrap = mobileProbe?.homeBootstrapEvidence?.() ?? null;
          mobileUiDiagnostic = { status: "ERROR", sampleCount: 1, variant: "B",
            failure: safeFailureMetadata(failure), ...(homeBootstrap ? { homeBootstrap } : {}) };
        }
        await context.writeArtifactJsonInternal("mobile-new-dom-diagnostic.json", mobileUiDiagnostic).catch(() => undefined);
        throw failure;
      } finally { if (mobileProbe) await mobileProbe.close(); }
    }

    const channelsBeforeRevoke = dataOpens().length;
    await http("public-revoke", `${route}/api/mobile/session`, { method: "DELETE", headers: authHeaders() }, 204); revoked = true;
    assert.equal(dataOpens().length, channelsBeforeRevoke + 1, "session revoke must use exactly one additional Relay channel");
    assert.equal(new Set(dataOpens().map(row => row.correlation)).size, dataOpens().length);
    assert.equal(collector.snapshot().droppedCount, 0); assert.equal(collector.snapshot().rejectedCount, 0);
    if (publicServersFailures.length > 0) {
      throw new Error(`${publicServersFailures.length} of ten independent read-only public server GET samples failed`);
    }
    return report();
  } finally { await context.writeArtifactJsonInternal("baseline-measurements.json", report()); }

  function dataOpens() { return collector.snapshot().events.filter(row => row.event === "data_open"); }
  function authHeaders() { return { Origin: origin, Authorization: `Bearer ${session.accessToken}` }; }
  async function measure(stage, callback, metadata = () => ({}), onStart) {
    const start = performance.now(), first = dataOpens().length;
    onStart?.(start);
    try { const value = await callback(); samples.push({ stage, elapsedMs: performance.now() - start, error: false, ...metadata(value) }); return value; }
    catch (failure) { samples.push({ stage, elapsedMs: performance.now() - start, error: true, ...metadata(),
      failure: safeFailureMetadata(failure) }); throw new Error(`${stage} failed; response bodies are not retained`); }
    finally { phases.push({ stage, fromChannelOrdinal: first, toChannelOrdinal: dataOpens().length,
      correlations: dataOpens().slice(first).map(row => row.correlation) }); }
  }
  async function http(stage, url, options, statusCode, { onStart, validate } = {}) {
    let observedStatus = null;
    return measure(stage, async () => {
      const signal = stage === "cleanup-revoke" ? AbortSignal.timeout(20_000) : AbortSignal.any([context.abortSignal, AbortSignal.timeout(20_000)]);
      const response = await fetch(url, { ...options, redirect: "manual", signal }); observedStatus = response.status;
      if (response.status !== statusCode) {
        try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
        assert.equal(response.status, statusCode, "unexpected public HTTP status");
      }
      if (statusCode === 204) { await response.arrayBuffer(); return null; }
      const value = await response.json(); // Private session body stays in memory and never enters an artifact.
      validate?.(value);
      return value;
    }, value => ({ statusCode: observedStatus, ...(Array.isArray(value?.servers) ? { resultCount: value.servers.length } : {}) }), onStart);
  }
  async function settlePublicServers504({ startedAt, eventOffset, droppedCount, rejectedCount }) {
    const responseAt = performance.now();
    const deadline = responseAt + 1500;
    let snapshot = collector.snapshot();
    const relevantEvents = () => snapshot.events.slice(eventOffset);
    const candidateCorrelations = untilMs => [...new Set(relevantEvents()
      .filter(row => row.event === "open_received" && row.monotonicMs >= startedAt && row.monotonicMs <= untilMs)
      .map(row => row.correlation).filter(value => typeof value === "string"))];
    const terminalEventsFor = correlation => relevantEvents().filter(row => row.correlation === correlation &&
      row.monotonicMs >= responseAt && row.monotonicMs <= deadline &&
      ["data_error", "data_close", "local_error", "local_timeout", "local_close", "bridge_closed"].includes(row.event));
    let correlations = candidateCorrelations(Math.min(performance.now(), deadline));
    while (performance.now() < deadline) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
      snapshot = collector.snapshot(); correlations = candidateCorrelations(Math.min(performance.now(), deadline));
    }
    snapshot = collector.snapshot();
    const finishedAt = performance.now();
    correlations = candidateCorrelations(Math.min(finishedAt, deadline));
    const paired = correlations.length === 1 ? correlations[0] : null;
    return {
      status: correlations.length === 1 ? "UNIQUE_WINDOW_CORRELATION" : correlations.length === 0 ? "UNPAIRED" : "AMBIGUOUS",
      association: "serialized GET interval and Relay open_received event; Relay diagnostics expose no HTTP request id",
      correlation: paired,
      candidateCorrelationCount: correlations.length,
      requestStartedAtMs: startedAt,
      responseObservedAtMs: responseAt,
      settleElapsedMs: finishedAt - responseAt,
      settleBudgetMs: 1500,
      settleDeadlineOvershootMs: Math.max(0, finishedAt - deadline),
      sameCorrelationTerminalEvents: paired ? terminalEventsFor(paired).map(row => ({
        event: row.event, afterResponseMs: row.monotonicMs - responseAt,
        ...(row.errorKind ? { errorKind: row.errorKind } : {}), ...(row.closeCode ? { closeCode: row.closeCode } : {}),
      })) : [],
      terminalOutcome: paired && terminalEventsFor(paired).length > 0 ? "LATE_TERMINAL_EVENT_OBSERVED" : "NO_TERMINAL_EVENT_WITHIN_BUDGET",
      collectorDropsDuringSettle: snapshot.droppedCount - droppedCount,
      collectorRejectionsDuringSettle: snapshot.rejectedCount - rejectedCount,
    };
  }
  async function rpcSetup(stage, url) {
    url.searchParams.set("token", session.rpcToken); url.searchParams.set("server", "baseline-local"); url.searchParams.set("channel", "runtime"); url.searchParams.set("workspace", workspace);
    const requestOrigin = new URL(url.href);
    requestOrigin.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return measure(stage, async () => {
      const rpc = await measure(`${stage}-handshake`, () => openRpc(url.href, {
        headers: { ...authHeaders(), Origin: requestOrigin.origin }, timeoutMs: 20_000,
        onDiagnostic: record => recordWebSocketTransportDiagnostic(stage, record),
      })); activeRpcs.add(rpc);
      const initialized = await measure(`${stage}-initialize`, () => initializeRpc(rpc, "public-rust-baseline"));
      assert.equal(initialized.protocolVersion, "2026-07-27");
      rpc.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" })); return rpc;
    });
  }
  async function listTen(stage, rpc) {
    const startChannels = dataOpens().length;
    for (let i = 0; i < 10; i++) await measure(stage, async () => {
      const result = await rpc.request("thread/list", { limit: 20, archived: false }, 20_000);
      assert.ok(Array.isArray(result.threads)); assert.equal(result.threads.length, 0, "isolated workspace has no threads");
      return result;
    }, result => ({ ...(Array.isArray(result?.threads) ? { resultCount: result.threads.length } : {}) }));
    assert.equal(dataOpens().length, startChannels, "ten lists must share the initialized socket");
  }
  function report() {
    return { evidenceClass: "one Mobile Web B New diagnostic on a Node-paired real Rust public session plus Node read-only baseline", sampleCountPerList: 10,
      limitations: ["Mobile DOM is one functional diagnostic, not n10/n30, native, physical-phone, or cellular evidence", "profile is harness-seeded in memory from the one Node-paired legacy session; no UI pairing is measured", "static Mobile assets are fulfilled from a pinned bundle; only dynamic HTTP/WSS uses public TLS", "public backend starts cold; local comparator uses the already-initialized backend; delta is not a pure RTT estimate", "public-first GET differs from subsequent transport warmth; no cache claim"],
      mobileUiDiagnostic,
      publicServersFailurePolicy: "10 serial independent read-only GET attempts when responses are 200/504; no retries; each 504 remains an error and sampling continues; a 504 observes only its unique window-correlated Relay channel for up to 1500ms",
      publicServersFailures,
      publicServersAttempted: samples.filter(row => row.stage === "public-servers").length,
      publicServersChannelExpectation,
      path: "request and Relay client control/data: public TLS443 → isolated Caddy → owned remote loopback ingress32552 → owned remote Relay → owned local Gateway → fixed Rust",
      topologyCost: "test-owned Relay and ingress run on the selected remote test host; no request-path reverse SSH or local Relay proxy",
      samples, summaries: Object.fromEntries([...new Set(samples.map(row => row.stage))].map(stage => [stage, summarize(samples.filter(row => row.stage === stage))])),
      publicHttpFirst: samples.find(row => row.stage === "public-servers"), publicHttpSubsequent: summarize(samples.filter(row => row.stage === "public-servers").slice(1)),
      phases, relayDiagnostics: collector.snapshot(), websocketTransportDiagnostics, websocketTransportDiagnosticsDropped, revoked };
  }
});

function seededLegacyMobileStorageState(session, gatewayBaseUrl, runSeed) {
  assert.ok(session && typeof session.accessToken === "string" && session.accessToken.length > 0);
  assert.ok(typeof session.rpcToken === "string" && session.rpcToken.length > 0);
  assert.ok(Number.isFinite(session.expiresAt) && session.expiresAt > Date.now());
  const route = new URL(gatewayBaseUrl);
  const baseUrl = `${route.origin}${route.pathname.replace(/\/+$/, "")}`;
  const runKey = createHash("sha256").update(String(runSeed)).digest("hex").slice(0, 20);
  const profileId = `public-rust-baseline-${runKey}`;
  const authorizationGeneration = typeof session.authorizationGeneration === "string" && session.authorizationGeneration.length > 0
    ? session.authorizationGeneration : `auth-e2e-${runKey}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < profileId.length; index += 1) { hash ^= profileId.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  const secretKey = `kcoder-studio-mobile.gateway-secret.${(hash >>> 0).toString(16).padStart(8, "0")}.v3.e2e.${runKey}`;
  const profile = { id: profileId, label: "Owned Rust baseline", baseUrl, expiresAt: session.expiresAt,
    authorizationGeneration, authMode: "legacy", secretKey };
  const secret = { profileId, baseUrl, authorizationGeneration, accessToken: session.accessToken, rpcToken: session.rpcToken };
  return { cookies: [], origins: [{ origin: route.origin, localStorage: [
    { name: "kcoder-studio-mobile.gateway-profiles.v2", value: JSON.stringify({ profiles: [profile], activeId: profileId }) },
    { name: secretKey, value: JSON.stringify(secret) },
  ] }] };
}

function required(name) { const value = process.env[name]; assert.ok(value, `${name} must be supplied for this manual run`); return value; }
async function shaFile(path) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function filePin(path) { return { bytes: (await stat(path)).size, sha256: await shaFile(path) }; }
async function verifyFrozenCftChrome() {
  const info = await lstat(frozenCftChromePath);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "pinned CFT Chromium must be a regular non-symlink file");
  assert.equal(await realpath(frozenCftChromePath), frozenCftChromePath, "pinned CFT Chromium path must be canonical");
  assert.ok((info.mode & 0o111) !== 0, "pinned CFT Chromium must remain executable");
  const actual = await filePin(frozenCftChromePath);
  assert.deepEqual(actual, { bytes: frozenCftChromePin.bytes, sha256: frozenCftChromePin.sha256 },
    "pinned CFT Chromium bytes changed");
  return { path: frozenCftChromePath, ...actual, version: frozenCftChromePin.version, mode: info.mode & 0o777 };
}
function summarize(rows) {
  const values = rows.filter(row => !row.error).map(row => row.elapsedMs).sort((a, b) => a - b), n = values.length;
  return { count: rows.length, errors: rows.length - n, medianMs: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
    p90Ms: n ? values[Math.ceil(n * 0.9) - 1] : null, maxMs: n ? values[n - 1] : null };
}
function safeFailureMetadata(error) {
  const result = { errorName: null, errorCode: null, causeCode: null };
  try {
    const allowedNames = new Set(["Error", "TypeError", "RangeError", "AssertionError", "TimeoutError", "AbortError", "AggregateError"]);
    const name = error?.name;
    result.errorName = allowedNames.has(name) ? name : "OtherError";
    if (typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)) result.errorCode = error.code;
    const cause = error?.cause;
    if (cause && typeof cause === "object") {
      if (typeof cause.code === "string" && /^[A-Z0-9_]{1,64}$/.test(cause.code)) result.causeCode = cause.code;
      const socket = cause.socket;
      if (socket && typeof socket === "object") {
        if (Number.isSafeInteger(socket.bytesRead) && socket.bytesRead >= 0) result.causeSocketBytesRead = socket.bytesRead;
        if (Number.isSafeInteger(socket.bytesWritten) && socket.bytesWritten >= 0) result.causeSocketBytesWritten = socket.bytesWritten;
      }
    }
  } catch {}
  return result;
}
async function privateJson(path) {
  const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600 && info.size < 65536, "private fixture must be owned regular 0600");
  try { return JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("private fixture is not valid JSON"); }
}
async function verifyFrozenRelayRuntime() {
  const runtimeInventoryPath = frozenRelaySourceInventoryPath;
  const runtimeInventoryAfterPath = runtimeInventoryPath.replace("runtime-src-before.sha256", "runtime-src-after.sha256");
  const relayEvidenceRoot = resolve(repoRoot,
    "target/private-phone-ux-implementation/relay-eof-drain-20261009/controlled-run-01");
  const privateSourceBeforePath = resolve(relayEvidenceRoot, "private-source-before.json");
  const privateSourceAfterPath = resolve(relayEvidenceRoot, "private-source-after.json");
  const sharedSourceBeforePath = resolve(relayEvidenceRoot, "shared-source-before.json");
  await noSymlinkPath(runtimeInventoryPath); await noSymlinkPath(runtimeInventoryAfterPath);
  for (const path of [privateSourceBeforePath, privateSourceAfterPath, sharedSourceBeforePath]) await noSymlinkPath(path);
  const beforeInfo = await lstat(runtimeInventoryPath), afterInfo = await lstat(runtimeInventoryAfterPath);
  assert.ok(beforeInfo.isFile() && !beforeInfo.isSymbolicLink() && beforeInfo.uid === process.getuid());
  assert.ok(afterInfo.isFile() && !afterInfo.isSymbolicLink() && afterInfo.uid === process.getuid());
  const beforeBytes = await readFile(runtimeInventoryPath), afterBytes = await readFile(runtimeInventoryAfterPath);
  assert.equal(createHash("sha256").update(beforeBytes).digest("hex"), frozenRelaySourceInventorySha256,
    "frozen Relay actual runtime source projection changed");
  assert.equal(createHash("sha256").update(afterBytes).digest("hex"), frozenRelaySourceInventorySha256,
    "frozen Relay post-run source projection changed");
  assert.deepEqual(afterBytes, beforeBytes, "frozen Relay runtime source projection must remain unchanged");

  const sourceFiles = {};
  const prefix = `${relayRoot}/`;
  const lines = beforeBytes.toString("utf8").trimEnd().split("\n");
  assert.equal(lines.length, 12, "the frozen Relay runtime source projection must contain exactly twelve files");
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    assert.ok(match, "frozen Relay source inventory line must be a standard sha256sum record");
    const [, sha256, absolutePath] = match;
    assert.ok(absolutePath.startsWith(`${prefix}src/`), "Relay source inventory must stay within the frozen runtime src root");
    const relativePath = absolutePath.slice(prefix.length);
    assert.equal(resolve(relayRoot, relativePath), absolutePath, "Relay source inventory path must be canonical");
    assert.equal(Object.hasOwn(sourceFiles, relativePath), false, "Relay runtime source paths must be unique");
    await noSymlinkPath(absolutePath);
    const info = await lstat(absolutePath);
    assert.ok(info.isFile() && !info.isSymbolicLink(), "frozen Relay source must be a regular non-symlink file");
    const pin = await filePin(absolutePath);
    assert.equal(pin.sha256, sha256, `frozen Relay runtime source changed: ${relativePath}`);
    sourceFiles[relativePath] = pin;
  }

  const historicalMapPins = {
    privateSourceBeforeSha256: "caaf5c4c2e4313898b08b0e2b60de0d8ac42362e5076ba0b7a48d3d5bc7d284f",
    privateSourceAfterSha256: "caaf5c4c2e4313898b08b0e2b60de0d8ac42362e5076ba0b7a48d3d5bc7d284f",
    sharedSourceBeforeSha256: "a99106f63c491c85c92410377c84e569a76f15b0e9d01645383e28afc6442db1",
  };
  const privateBeforeBytes = await readFile(privateSourceBeforePath);
  const privateAfterBytes = await readFile(privateSourceAfterPath);
  const sharedBeforeBytes = await readFile(sharedSourceBeforePath);
  const actualPrivateBeforeSha = createHash("sha256").update(privateBeforeBytes).digest("hex");
  const actualPrivateAfterSha = createHash("sha256").update(privateAfterBytes).digest("hex");
  const actualSharedBeforeSha = createHash("sha256").update(sharedBeforeBytes).digest("hex");
  assert.equal(actualPrivateBeforeSha, historicalMapPins.privateSourceBeforeSha256);
  assert.equal(actualPrivateAfterSha, historicalMapPins.privateSourceAfterSha256);
  assert.equal(actualSharedBeforeSha, historicalMapPins.sharedSourceBeforeSha256);
  const privateSourceBefore = JSON.parse(privateBeforeBytes.toString("utf8"));
  const sharedSourceBefore = JSON.parse(sharedBeforeBytes.toString("utf8"));
  assert.equal(privateSourceBefore["src/server.mjs"]?.sha256, sourceFiles["src/server.mjs"]?.sha256);
  assert.notEqual(privateSourceBefore["src/transport.mjs"]?.sha256, sourceFiles["src/transport.mjs"]?.sha256);
  assert.notEqual(sharedSourceBefore["src/server.mjs"]?.sha256, sourceFiles["src/server.mjs"]?.sha256);
  assert.notEqual(sharedSourceBefore["src/transport.mjs"]?.sha256, sourceFiles["src/transport.mjs"]?.sha256);

  const packagePins = {};
  for (const [name, expectedPin] of Object.entries(frozenRelayPackagePins)) {
    const path = resolve(relayRoot, name);
    await noSymlinkPath(path);
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `frozen Relay ${name} must be a regular file`);
    const actualPin = await filePin(path);
    assert.deepEqual(actualPin, expectedPin, `frozen Relay ${name} changed`);
    packagePins[name] = actualPin;
  }
  return {
    root: relayRoot,
    sourceInventoryPath: runtimeInventoryPath,
    sourceInventorySha256: frozenRelaySourceInventorySha256,
    sourceFileCount: Object.keys(sourceFiles).length,
    sourceFiles,
    packagePins,
    remoteArchiveContract: {
      harnessPath: "apps/kcoder-studio/e2e/harness/remote-relay-lifecycle.mjs",
      harnessSha256: expected["apps/kcoder-studio/e2e/harness/remote-relay-lifecycle.mjs"],
      runtimeSourceCount: 5,
      wsFileCount: 19,
      totalArchiveFileCount: 28,
      enforcement: "startOwnedRemoteRelay.verifyLocalRuntime checks the selected five source files, Node binary, ingress helper, and 19 ws files before upload",
    },
    historicalMapsNotUsedAsRuntimeAuthority: {
      privateSourceBeforeSha256: actualPrivateBeforeSha,
      privateSourceAfterSha256: actualPrivateAfterSha,
      sharedSourceBeforeSha256: actualSharedBeforeSha,
      reason: "the exact runtime-src-before/runtime-src-after checksum projection is the executed runtime authority; the private before/after maps disagree on transport and the shared map disagrees on server and transport",
    },
  };
}

async function sourceInventory({ readOnlyObservation = false, executedGatewayRuntime = null,
  executedRelayRuntime = null } = {}) {
  const frozenRuntimeExecution = executedGatewayRuntime !== null || executedRelayRuntime !== null;
  assert.equal(executedGatewayRuntime !== null, executedRelayRuntime !== null,
    "the frozen execution profile requires both its Gateway and Relay pins");
  const paths = new Set([process.execPath, fileURLToPath(import.meta.url), sshConfig, sshKnownHosts, resolve(appRoot, "e2e/private/header-websocket-ws-diagnostic.mjs"), resolve(appRoot, "e2e/private/rpc-ws-diagnostic.mjs"), resolve(appRoot, "e2e/private/mobile-public-new-catalog-dom-probe.candidate.mjs"), resolve(appRoot, "e2e/private/mobile-public-home-waterfall-336-339.candidate.mjs"), resolve(repoRoot, "apps/kcoder-studio/e2e/suites/mobile/routes-only-sidecar-config.candidate.mjs"), resolve(appRoot, "dev-server.mjs"), resolve(appRoot, "package.json"), resolve(appRoot, "pnpm-lock.yaml"), resolve(relayRoot, "package-lock.json")]);
  async function tree(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) await tree(path); else if (entry.isFile()) paths.add(path);
      else if (entry.isSymbolicLink()) {
        const resolved = await realpath(path), info = await stat(resolved);
        assert.ok(info.isFile(), "inventory does not follow directory symlinks"); paths.add(resolved);
      } else throw new Error("inventory encountered a non-file source");
    }
  }
  for (const root of [resolve(appRoot, "src"), resolve(appRoot, "shared"), resolve(appRoot, "e2e/harness"),
    resolve(repoRoot, "apps/kcoder-relay/src"), resolve(relayRoot, "src")]) await tree(root);
  paths.add(resolve(relayRoot, "package.json")); paths.add(resolve(repoRoot, "apps/kcoder-relay/package.json"));
  const dependencyRoots = new Set();
  async function dependency(require, name, optional = false) {
    let packagePath;
    try { packagePath = require.resolve(`${name}/package.json`); }
    catch { assert.ok(optional, "required Node dependency must resolve"); return; }
    const root = dirname(packagePath); if (dependencyRoots.has(root)) return; dependencyRoots.add(root);
    await tree(root);
    const pkg = JSON.parse(await readFile(packagePath, "utf8")), childRequire = createRequire(packagePath);
    for (const child of Object.keys(pkg.dependencies || {})) await dependency(childRequire, child, Object.hasOwn(pkg.optionalDependencies || {}, child));
    for (const child of Object.keys(pkg.optionalDependencies || {})) await dependency(childRequire, child, true);
  }
  for (const root of [appRoot, relayRoot]) {
    const require = createRequire(resolve(root, "package.json"));
    for (const name of (root === relayRoot ? ["ws"] : ["jsonc-parser", "ssh2"])) await dependency(require, name);
  }
  assert.ok(paths.size < 4096, "bounded source/dependency inventory");
  const rows = {};
  for (const path of [...paths].sort()) rows[path] = await filePin(path);
  const liveExpectedPinDrifts = [];
  for (const [path, sha256] of Object.entries(expected)) {
    const actual = rows[resolve(repoRoot, path)] ?? null;
    if (actual?.sha256 !== sha256) liveExpectedPinDrifts.push({ path, expectedSha256: sha256,
      actualSha256: actual?.sha256 ?? null, actualBytes: actual?.bytes ?? null });
  }
  const frozenBackendPaths = new Set([
    "apps/kcoder-studio/dev-server.mjs",
    "apps/kcoder-studio/src/workspace-app-server-broker.js",
    "apps/kcoder-relay/src/server.mjs",
  ]);
  const expectedPinDrifts = frozenRuntimeExecution
    ? liveExpectedPinDrifts.filter(row => !frozenBackendPaths.has(row.path))
    : liveExpectedPinDrifts;
  const relayFiles = root => Object.fromEntries(Object.entries(rows).filter(([path]) => path.startsWith(resolve(root, "src") + "/"))
    .map(([path, row]) => [path.slice(resolve(root, "src").length + 1), row]));
  const frozenRelayFiles = relayFiles(relayRoot), liveRelayFiles = relayFiles(resolve(repoRoot, "apps/kcoder-relay"));
  const relayPaths = [...new Set([...Object.keys(frozenRelayFiles), ...Object.keys(liveRelayFiles)])].sort();
  const relaySourceDrifts = relayPaths.filter(path => JSON.stringify(frozenRelayFiles[path] ?? null) !== JSON.stringify(liveRelayFiles[path] ?? null))
    .map(path => ({ path, frozen: frozenRelayFiles[path] ?? null, live: liveRelayFiles[path] ?? null }));
  const relayPackageDrifts = {};
  for (const path of ["package.json", "package-lock.json"]) {
    const frozen = await filePin(resolve(relayRoot, path)), live = await filePin(resolve(repoRoot, "apps/kcoder-relay", path));
    if (JSON.stringify(frozen) !== JSON.stringify(live)) relayPackageDrifts[path] = { frozen, live };
  }
  const frozenGatewaySourceDrifts = [];
  if (executedGatewayRuntime) {
    const gatewayManifest = JSON.parse(await readFile(executedGatewayRuntime.manifestPath, "utf8"));
    for (const row of gatewayManifest.sourceFiles) {
      const livePath = resolve(appRoot, row.path);
      const livePin = rows[livePath] ?? await filePin(livePath).catch(() => null);
      if (!livePin || livePin.sha256 !== row.sha256 || livePin.bytes !== row.size) {
        frozenGatewaySourceDrifts.push({ path: row.path, frozenSha256: row.sha256, frozenBytes: row.size,
          liveSha256: livePin?.sha256 ?? null, liveBytes: livePin?.bytes ?? null });
      }
    }
  }
  const unexecutedLiveBackendDifferences = frozenRuntimeExecution ? {
    reviewedPinPaths: liveExpectedPinDrifts.filter(row => frozenBackendPaths.has(row.path)),
    gatewayAgainstFrozenC22: frozenGatewaySourceDrifts,
    relayAgainstFrozenRuntime: relaySourceDrifts,
    relayPackageDrifts,
  } : null;
  sourceInventoryObservation = {
    mode: readOnlyObservation ? "READ_ONLY_CURRENT_SOURCE_OBSERVATION"
      : frozenRuntimeExecution ? "FROZEN_C22_GATEWAY_AND_FROZEN_RELAY_EXECUTION"
        : "STRICT_PINNED_SOURCE_GATE",
    expectedPinDrifts,
    ...(frozenRuntimeExecution ? { unexecutedLiveBackendDifferences,
      executedGatewayRuntime, executedRelayRuntime } : {}),
    relayRuntime: { frozenRoot: relayRoot, liveRoot: resolve(repoRoot, "apps/kcoder-relay"),
      frozenSourceFileCount: Object.keys(frozenRelayFiles).length, liveSourceFileCount: Object.keys(liveRelayFiles).length,
      sourceDrifts: relaySourceDrifts, packageDrifts: relayPackageDrifts },
  };
  if (!readOnlyObservation) {
    assert.deepEqual(expectedPinDrifts, [], "reviewed integration source must match");
    if (!frozenRuntimeExecution) {
      assert.deepEqual(relaySourceDrifts, [], "complete recursive Relay file set/bytes must match integration");
      assert.deepEqual(relayPackageDrifts, {}, "complete Relay package manifests must match integration");
    } else {
      assert.equal(executedGatewayRuntime.manifestSha256, frozenGatewayPins.expectedManifestSha256);
      assert.equal(executedGatewayRuntime.sourceTreeSha256, frozenGatewayPins.expectedSourceTreeSha256);
      assert.equal(executedGatewayRuntime.dependencyTreeSha256, frozenGatewayPins.expectedDependencyTreeSha256);
      assert.equal(executedRelayRuntime.sourceInventorySha256, frozenRelaySourceInventorySha256);
      assert.equal(executedRelayRuntime.sourceFileCount, 12);
    }
  }
  return rows;
}
async function proveRustChild(context, gatewayPid) {
  const nodes = [];
  for (const name of await readdir("/proc")) if (/^[0-9]+$/.test(name)) {
    try { const text = await readFile(`/proc/${name}/stat`, "utf8"); nodes.push({ pid: Number(name), parent: Number(text.slice(text.lastIndexOf(")") + 2).split(" ")[1]) }); } catch {}
  }
  const owned = new Set([gatewayPid]);
  for (let i = 0; i < nodes.length; i++) for (const row of nodes) if (owned.has(row.parent)) owned.add(row.pid);
  const matches = [];
  for (const pid of owned) if (pid !== gatewayPid) {
    try { if (await realpath(`/proc/${pid}/exe`) === await realpath(binary)) matches.push(pid); } catch {}
  }
  assert.equal(matches.length, 1, "initialized Gateway must own the fixed Rust app-server child");
  const actual = await stat(`/proc/${matches[0]}/exe`), fixed = await stat(binary);
  assert.ok(actual.dev === fixed.dev && actual.ino === fixed.ino && actual.size === fixed.size, "child executable must be the prehashed immutable file");
  await context.writeArtifactJson("rust-child-proof.json", { gatewayPid, appServerPid: matches[0], executableSha256: binarySha,
    proof: "exact executable path/device/inode/size matches prehashed fixed binary; binary rehashed after cleanup", mock: false });
}
async function noSymlinkPath(path) {
  let current = "/";
  for (const component of resolve(path).split("/").filter(Boolean)) {
    current = resolve(current, component); assert.equal((await lstat(current)).isSymbolicLink(), false, "private/trust path cannot traverse a symlink");
  }
}
async function remoteProbe(context, label, expectation) {
  // Read-only process/config projection. Relay routes are proven by the exact validated candidate SHA, not Caddyfile spacing.
  const expected = JSON.stringify({
    sidecarConfigPath: expectation.configPath, sidecarConfigSha256: expectation.configSha256,
    expectedSidecarPid: expectation.pid, privateSidecarConfig: expectation.privateConfig === true,
    productionConfigPath, productionConfigSha256, productionPid,
  });
  const python = `import pathlib,hashlib,json,subprocess,re,os
p=json.loads(${JSON.stringify(expected)})
sha=lambda b:hashlib.sha256(b).hexdigest()
def process(pid,config):
 q=pathlib.Path('/proc')/str(pid); av=q.joinpath('cmdline').read_bytes().split(b'\\0')
 if av and not av[-1]: av=av[:-1]
 uid=re.search(r'^Uid:\\s+(\\d+)\\s+(\\d+)',q.joinpath('status').read_text(),re.M)
 return dict(pid=pid,exe=os.readlink(q/'exe'),euid=int(uid.group(2)) if uid else None,
   argvConfigMatch=any(av[i]==b'--config' and i+1<len(av) and av[i+1].decode()==config for i in range(len(av)-1)),
   argvSha256=sha(b'\\0'.join(av)))
def listener(port): return subprocess.check_output(['ss','-H','-ltnp','sport = :'+str(port)],text=True)
def pids(text): return sorted({int(x) for x in re.findall(r'pid=(\\d+),',text)})
cfg=pathlib.Path(p['sidecarConfigPath']); cfgsha=sha(cfg.read_bytes()); assert cfgsha==p['sidecarConfigSha256']
if p['privateSidecarConfig']:
 st=cfg.lstat(); import stat
 assert stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_uid==0 and stat.S_IMODE(st.st_mode)==0o600
tls=listener(443); sidecarPids=pids(tls); assert tls and len(sidecarPids)==1
sidecarPid=sidecarPids[0]; assert p['expectedSidecarPid'] is None or sidecarPid==p['expectedSidecarPid']
sidecar=process(sidecarPid,p['sidecarConfigPath']); assert sidecar['exe']=='/usr/bin/caddy' and sidecar['euid']==0 and sidecar['argvConfigMatch']
prodCfg=pathlib.Path(p['productionConfigPath']); prodsha=sha(prodCfg.read_bytes()); assert prodsha==p['productionConfigSha256']
prod=listener(8451); prodPids=pids(prod); assert prod and prodPids==[p['productionPid']]
production=process(prodPids[0],p['productionConfigPath']); assert production['exe']=='/usr/bin/caddy' and production['euid']==996 and production['argvConfigMatch']
forward=listener(32552); forwardPids=pids(forward); assert len(forwardPids)<=1
if forwardPids: assert 'sshd' in (pathlib.Path('/proc')/str(forwardPids[0])/'comm').read_text()
print(json.dumps(dict(forwardFree=not bool(forward),productionOwners=[production],productionListenerSha256=sha(prod.encode()),
 sidecar=dict(pid=sidecarPid,exeMatches=True,euid=sidecar['euid'],configSha256=cfgsha,argvConfigMatch=True)),separators=(',',':')))
`;
  const output = await remoteOutput(context, label,
    `sudo -n python3 -c ${shellQuote(buildMarkedPythonSource(python))}`, 20_000);
  try { return JSON.parse(output); } catch { throw new Error("remote invariant projection invalid"); }
}

async function remoteStaticRootProjection(context, label, expectation) {
  const payload = JSON.stringify({ configPath: expectation.configPath, configSha256: expectation.configSha256,
    staticRoot: expectedStaticRoot, expectedFiles: expectedStaticFiles });
  const python = `import pathlib,hashlib,json,subprocess,re,os
p=json.loads(${JSON.stringify(payload)})
sha=lambda b:hashlib.sha256(b).hexdigest()
cfg=pathlib.Path(p['configPath']); assert sha(cfg.read_bytes())==p['configSha256']
adapt=subprocess.run(['/usr/bin/caddy','adapt','--config',str(cfg),'--adapter','caddyfile'],capture_output=True,timeout=8,check=True)
doc=json.loads(adapt.stdout); roots=set()
def visit(node):
 if isinstance(node,dict):
  if node.get('handler') in ('vars','file_server'):
   root=node.get('root')
   if isinstance(root,str) and root.startswith('/'): roots.add(root)
  for value in node.values(): visit(value)
 elif isinstance(node,list):
  for value in node: visit(value)
visit(doc)
assert roots=={p['staticRoot']}
root=pathlib.Path(p['staticRoot']); info=os.lstat(root); assert not pathlib.Path(root).is_symlink() and os.path.isdir(root)
rows=[]
for current,dirs,files in os.walk(root,topdown=True,followlinks=False):
 dirs.sort(); files.sort()
 for name in list(dirs)+files:
  path=pathlib.Path(current)/name; st=os.lstat(path)
  assert not path.is_symlink()
  if name in dirs: assert os.path.isdir(path)
  else:
   assert os.path.isfile(path)
   h=hashlib.sha256()
   with open(path,'rb') as stream:
    for chunk in iter(lambda:stream.read(1024*1024),b''): h.update(chunk)
   rows.append([path.relative_to(root).as_posix(),st.st_size,str(st.st_mtime_ns),h.hexdigest()])
rows.sort(); assert len(rows)==p['expectedFiles']
treeSha=sha(json.dumps(rows,separators=(',',':'),ensure_ascii=True).encode())
print(json.dumps(dict(fileCount=len(rows),treeSha256=treeSha),separators=(',',':')))
`;
  const output = await remoteOutput(context, label,
    `sudo -n python3 -c ${shellQuote(buildMarkedPythonSource(python))}`, 20_000);
  try { return JSON.parse(output); } catch { throw new Error("static-root projection invalid"); }
}

async function installAndStartRoutesOnlySidecar(context, transaction, remoteBefore, staticRootBefore, sshTransport) {
  const baseBytes = await remoteReadBytes(context, "routes-only-base-config", transaction.original.configPath);
  const base = baseBytes.toString("utf8");
  assert.equal(createHash("sha256").update(baseBytes).digest("hex"), transaction.original.configSha256, "isolated sidecar base config changed before candidate creation");
  const built = buildRoutesOnlySidecarCandidate(base, { marker: transaction.marker, targetPort: 32552 });
  assert.equal(built.baseSha256, transaction.original.configSha256);
  assert.equal(removeRoutesOnlyMarker(built.candidate, transaction.marker), base);
  transaction.candidateSha256 = built.candidateSha256;

  const ownerMarker = transaction.marker + "\n";
  const createOwnerScript = [
    "import json,os,re,stat,sys",
    "root=sys.argv[1]",
    "marker=sys.argv[2]",
    "owner_bytes=(marker+'\\n').encode('utf-8')",
    "parent_flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC",
    "parent_fd=os.open('/tmp',parent_flags)",
    "try:",
    " parent=os.fstat(parent_fd)",
    " if parent.st_uid!=0 or not stat.S_ISDIR(parent.st_mode) or not (parent.st_mode&stat.S_ISVTX): raise SystemExit(71)",
    " name=os.path.basename(root)",
    " if os.path.dirname(root)!='/tmp' or not re.fullmatch(r'kc-phone-ux-rust-baseline-[0-9a-f]{24}',name): raise SystemExit(72)",
    " os.mkdir(name,0o700,dir_fd=parent_fd)",
    " os.fsync(parent_fd)",
    " root_flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC",
    " root_fd=os.open(name,root_flags,dir_fd=parent_fd)",
    " try:",
    "  root_st=os.fstat(root_fd)",
    "  if not stat.S_ISDIR(root_st.st_mode) or root_st.st_uid!=0 or stat.S_IMODE(root_st.st_mode)!=0o700: raise SystemExit(73)",
    "  owner_flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC",
    "  owner_fd=os.open('.owner',owner_flags,0o600,dir_fd=root_fd)",
    "  try:",
    "   remaining=memoryview(owner_bytes)",
    "   while remaining:",
    "    written=os.write(owner_fd,remaining)",
    "    if written<=0: raise OSError('owner marker write made no progress')",
    "    remaining=remaining[written:]",
    "   os.fsync(owner_fd)",
    "   owner_st=os.fstat(owner_fd)",
    "   if not stat.S_ISREG(owner_st.st_mode) or owner_st.st_uid!=0 or stat.S_IMODE(owner_st.st_mode)!=0o600 or owner_st.st_nlink!=1 or owner_st.st_size!=len(owner_bytes): raise SystemExit(74)",
    "  finally:",
    "   os.close(owner_fd)",
    "  os.fsync(root_fd)",
    "  receipt={'state':'owner-durable','rootUid':root_st.st_uid,'rootMode':stat.S_IMODE(root_st.st_mode),'rootDev':str(root_st.st_dev),'rootIno':str(root_st.st_ino),'ownerUid':owner_st.st_uid,'ownerMode':stat.S_IMODE(owner_st.st_mode),'ownerNlink':owner_st.st_nlink,'ownerSize':owner_st.st_size}",
    "  print(json.dumps(receipt,separators=(',',':')))",
    " finally:",
    "  os.close(root_fd)",
    "finally:",
    " os.close(parent_fd)",
  ].join("\n");
  const createOwnerCommand = "sudo -n python3 -c " + shellQuote(buildMarkedPythonSource(createOwnerScript))
    + " " + shellQuote(transaction.root) + " " + shellQuote(transaction.marker);
  const ownerReceiptOutput = await remoteOutput(context, "create-routes-only-owned-root-and-owner",
    createOwnerCommand);
  let ownerReceipt;
  try { ownerReceipt = JSON.parse(ownerReceiptOutput); } catch {
    throw new Error("owned route candidate root/owner durable receipt was invalid");
  }
  assert.equal(ownerReceipt.state, "owner-durable");
  assert.equal(ownerReceipt.rootUid, 0);
  assert.equal(ownerReceipt.rootMode, 0o700);
  assert.match(ownerReceipt.rootDev, /^[0-9]+$/);
  assert.match(ownerReceipt.rootIno, /^[0-9]+$/);
  assert.equal(ownerReceipt.ownerUid, 0);
  assert.equal(ownerReceipt.ownerMode, 0o600);
  assert.equal(ownerReceipt.ownerNlink, 1);
  assert.equal(ownerReceipt.ownerSize, Buffer.byteLength(ownerMarker));
  await sshWrite(context, "write-routes-only-candidate-config",
    `sudo -n sh -c ${shellQuote(`umask 077; cat > ${shellQuote(transaction.configPath)}`)}`,
    Buffer.from(built.candidate));
  const candidateShaOutput = await remoteOutput(context, "hash-routes-only-candidate",
    `sudo -n sha256sum ${shellQuote(transaction.configPath)} | awk '{print "sha256="$1}'`);
  const candidateSha = parseSha256Receipt(candidateShaOutput);
  assert.equal(candidateSha, transaction.candidateSha256, "uploaded sidecar candidate bytes differ from the reviewed local candidate");
  const validation = await remoteOutput(context, "validate-routes-only-candidate",
    `sudo -n /usr/bin/caddy validate --config ${shellQuote(transaction.configPath)} --adapter caddyfile`, 45_000);
  assert.match(validation, /Valid configuration/);

  const current = await remoteProbe(context, "routes-only-before-stop", transaction.original);
  assert.deepEqual(current, remoteBefore, "sidecar/production identity or port state changed before the route-only switch");
  const currentRoot = await remoteStaticRootProjection(context, "routes-only-before-stop-static", transaction.original);
  assert.deepEqual(currentRoot, staticRootBefore, "the 37-file public root changed before the route-only switch");

  transaction.originalStopRequested = true;
  const exitReceipt = await stopAndWaitForOriginalSidecarOnce(context, transaction.original, remoteBefore.sidecar,
    { repoRoot, sshTransport, waitFor });
  assert.equal(exitReceipt.state, "original-exited-443-free");
  assert.equal(exitReceipt.pidfd, true);
  assert.equal(exitReceipt.configSha256, transaction.original.configSha256);
  assert.equal(exitReceipt.port443Free, true);

  const launch = [
    "set -eu",
    `sudo -n bash -c ${shellQuote(`umask 077; nohup /usr/bin/caddy run --config ${transaction.configPath} --adapter caddyfile </dev/null >>${transaction.logPath} 2>&1 & echo $! > ${transaction.pidPath}`)}`,
    `pid=$(sudo -n cat ${shellQuote(transaction.pidPath)})`,
    `case "$pid" in ''|*[!0-9]*) exit 71 ;; esac`,
    `test "$pid" -gt 1`,
    `exe=$(sudo -n readlink "/proc/$pid/exe")`,
    `test "$exe" = /usr/bin/caddy`,
    `argv=$(sudo -n tr '\\000' ' ' < "/proc/$pid/cmdline")`,
    `case "$argv" in *${transaction.configPath}*) ;; *) exit 72 ;; esac`,
    `printf 'candidatePid=%s\\n' "$pid"`,
  ].join("; ");
  transaction.candidateStartRequested = true;
  const output = await remoteOutput(context, "start-owned-routes-only-sidecar", launch, 15_000);
  transaction.candidatePid = parseCandidatePidReceipt(output);
  assert.ok(Number.isInteger(transaction.candidatePid) && transaction.candidatePid > 1);
  transaction.candidateStarted = true;
  await waitFor(async () => {
    const listeners = Number((await remoteOutput(context, "wait-candidate-443-listener-count",
      "sudo -n ss -H -ltnp 'sport = :443' | wc -l")).trim());
    if (!listeners) return null;
    const state = await remoteProbe(context, `routes-only-candidate-listener-${++probeOrdinal}`, {
      configPath: transaction.configPath, configSha256: transaction.candidateSha256, pid: transaction.candidatePid, privateConfig: true,
    });
    return state.sidecar.pid === transaction.candidatePid ? true : null;
  }, 15_000, "owned route-only sidecar port 443 listener", 150, context.abortSignal);
  const candidateRoot = await remoteStaticRootProjection(context, "routes-only-candidate-static", {
    configPath: transaction.configPath, configSha256: transaction.candidateSha256, pid: transaction.candidatePid, privateConfig: true,
  });
  assert.deepEqual(candidateRoot, staticRootBefore, "route-only Caddy candidate must preserve the exact 37-file static root");
  await context.writeArtifactJson("routes-only-sidecar-candidate.json", {
    marker: transaction.marker, candidateConfigSha256: transaction.candidateSha256,
    originalConfigSha256: transaction.original.configSha256,
    exactRelayPathCount: 3, exactRelayPaths: ["/_relay/register", "/_relay/control", "/_relay/data"],
    staticRootPreserved: true, candidatePid: transaction.candidatePid,
    productionPid: productionPid, productionConfigSha256,
  });
}

async function restoreRoutesOnlySidecar(context, transaction, productionBefore) {
  return restoreRoutesOnlySidecarOnce(context, transaction, productionBefore, {
    repoRoot, sshOptions, sshTarget, productionConfigPath, productionConfigSha256,
    expectedStaticRoot, expectedStaticFiles,
  });
}

async function inspectExactSidecar(context, pid, configPath, configSha256) {
  const script = `import hashlib,json,os,pathlib,re,sys
cfg=sys.argv[1]; expected=sys.argv[2]; wanted=None if sys.argv[3]=='null' else int(sys.argv[3]); q=pathlib.Path(cfg)
if q.is_symlink() or not q.is_file() or hashlib.sha256(q.read_bytes()).hexdigest()!=expected: raise SystemExit(31)
found=[]
for item in pathlib.Path('/proc').iterdir():
 if not item.name.isdigit(): continue
 try:
  if wanted is not None and int(item.name)!=wanted: continue
  if os.readlink(item/'exe')!='/usr/bin/caddy': continue
  av=item.joinpath('cmdline').read_bytes().split(b'\\0'); av=av[:-1] if av and not av[-1] else av
  if av != [b'/usr/bin/caddy',b'run',b'--config',cfg.encode(),b'--adapter',b'caddyfile']: continue
  uid=re.search(r'^Uid:\\s+(\\d+)\\s+(\\d+)',item.joinpath('status').read_text(),re.M)
  if not uid or int(uid.group(2))!=0: raise RuntimeError('candidate-euid-mismatch')
  found.append(int(item.name))
 except FileNotFoundError: continue
if len(found)>1: raise SystemExit(32)
if not found: print(json.dumps({'state':'absent','pid':None})); raise SystemExit(0)
print(json.dumps({'state':'owned','pid':found[0]}))`;
  const output = await remoteOutput(context, "inspect-exact-owned-route-candidate",
    `sudo -n python3 -c ${shellQuote(buildMarkedPythonSource(script))} ${shellQuote(configPath)} ${configSha256} ${pid === null ? "null" : pid}`);
  let state;
  try { state = JSON.parse(output); } catch { throw new Error("route candidate identity projection was invalid"); }
  assert.ok(["absent", "owned"].includes(state.state), "route candidate identity projection was ambiguous");
  if (pid !== null && state.state === "owned") assert.equal(state.pid, pid, "candidate process must match the recorded owner PID");
  return state;
}

async function inspectOriginalSidecar(context, original) {
  const script = `import hashlib,json,os,pathlib,re,subprocess,sys
cfg=sys.argv[1]; expected=sys.argv[2]; q=pathlib.Path(cfg)
if q.is_symlink() or not q.is_file() or hashlib.sha256(q.read_bytes()).hexdigest()!=expected: raise SystemExit(41)
listeners=subprocess.run(['ss','-H','-ltnp','sport = :443'],capture_output=True,text=True,check=True).stdout
listener_pids=sorted({int(x) for x in re.findall(r'pid=(\\d+),',listeners)})
found=[]
for item in pathlib.Path('/proc').iterdir():
 if not item.name.isdigit(): continue
 try:
  if os.readlink(item/'exe')!='/usr/bin/caddy': continue
  av=item.joinpath('cmdline').read_bytes().split(b'\\0'); av=av[:-1] if av and not av[-1] else av
  if av != [b'/usr/bin/caddy',b'run',b'--config',cfg.encode(),b'--adapter',b'caddyfile']: continue
  uid=re.search(r'^Uid:\\s+(\\d+)\\s+(\\d+)',item.joinpath('status').read_text(),re.M)
  if not uid or int(uid.group(2))!=0: raise RuntimeError('original-euid-mismatch')
  found.append(int(item.name))
 except FileNotFoundError: continue
if len(found)>1 or len(listener_pids)>1: raise SystemExit(42)
if found and listener_pids and listener_pids != found: raise SystemExit(43)
if not found and listener_pids: raise SystemExit(44)
print(json.dumps({'state':'owned-original' if found else 'absent','pid':found[0] if found else None,'listening':bool(found and listener_pids==found)}))`;
  const output = await remoteOutput(context, "inspect-original-sidecar-state",
    `sudo -n python3 -c ${shellQuote(buildMarkedPythonSource(script))} ${shellQuote(original.configPath)} ${original.configSha256}`);
  let state;
  try { state = JSON.parse(output); } catch { throw new Error("original sidecar identity projection was invalid"); }
  assert.ok(["absent", "owned-original"].includes(state.state), "original sidecar identity projection was ambiguous");
  return state;
}

async function removeOwnedRoutesOnlyRoot(context, transaction) {
  const script = `import json,os,pathlib,shutil,stat,sys\nroot=pathlib.Path(sys.argv[1]); marker=sys.argv[2]\nif not os.path.lexists(root): print('absent'); raise SystemExit(0)\nif root.is_symlink() or not root.is_dir() or root.stat().st_uid!=0 or stat.S_IMODE(root.stat().st_mode)!=0o700: raise SystemExit(51)\nowner=root/'.owner'\nif owner.is_symlink() or not owner.is_file() or owner.stat().st_nlink!=1 or owner.read_text() != marker+'\\n': raise SystemExit(52)\nallowed={'.owner','isolated-443-front.Caddyfile','candidate.pid','candidate.log','original-restored.pid'}\nif not {p.name for p in root.iterdir()} <= allowed: raise SystemExit(53)\nfor p in root.iterdir():\n if p.is_symlink() or not p.is_file() or p.stat().st_uid!=0: raise SystemExit(54)\nshutil.rmtree(root)\nif root.exists() or root.is_symlink(): raise SystemExit(55)\nprint('absent')`;
  const output = await remoteOutput(context, "remove-exact-owned-route-candidate-root",
    `sudo -n python3 -c ${shellQuote(buildMarkedPythonSource(script))} ${shellQuote(transaction.root)} ${transaction.marker}`);
  assert.equal(output.trim(), "absent", "owned route candidate root must be removed only after its owner marker checks");
}

async function remoteReadBytes(context, label, path) {
  const callId = nextRemoteCallId();
  const startedAt = performance.now();
  const processLabel = `ssh-${callId}-${remoteArtifactSlug(label).slice(0, 88)}`;
  const stageObserver = createSshStageObserver(startedAt);
  const stdoutParts = [], stderrParts = [];
  let stdoutBytes = 0, stderrBytes = 0, overflow = false, child;
  let closeInfo = null;
  let spawnError = null, waitFailure = null, stopFailure = null;
  child = await context.spawnRemoteSsh(processLabel, `sudo -n cat ${shellQuote(path)}`, {
    cwd: repoRoot, env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
  });
  child.once("error", error => { spawnError = error; });
  child.once("close", (code, signal) => { closeInfo = { code, signal }; });
  child.stdout.on("data", chunk => {
    const bytes = Buffer.from(chunk); stdoutBytes += bytes.length;
    if (stdoutBytes <= 64 * 1024) stdoutParts.push(bytes); else overflow = true;
  });
  child.stderr.on("data", chunk => {
    const bytes = Buffer.from(chunk); stderrBytes += bytes.length;
    if (stderrBytes <= 8192) stderrParts.push(bytes); else overflow = true;
    stageObserver.push(bytes);
  });
  try { await waitFor(() => closeInfo !== null || spawnError !== null, 15_000, `bounded remote read ${label}`, 25, context.abortSignal); }
  catch (error) { waitFailure = error; }
  try { await context.stopOwned(processLabel); } catch (error) { stopFailure = error; }
  if (closeInfo === null) {
    try { await waitFor(() => closeInfo !== null, 5_000, `remote read terminal ${label}`, 25); } catch {}
  }
  const stdout = Buffer.concat(stdoutParts), stderr = Buffer.concat(stderrParts), stage = stageObserver.finish();
  const failed = Boolean(waitFailure || stopFailure || spawnError || !closeInfo || closeInfo.code !== 0 || overflow || !stage.valid);
  const evidence = {
    label, callId, processLabel, pid: child?.pid ?? null,
    exitCode: closeInfo?.code ?? child.exitCode ?? null,
    signal: closeInfo?.signal ?? child.signalCode ?? null,
    terminalObserved: closeInfo !== null,
    timedOut: Boolean(waitFailure && /Timed out/.test(String(waitFailure.message))),
    aborted: Boolean(context.abortSignal?.aborted),
    elapsedMs: performance.now() - startedAt, stdoutBytes: stdout.length, stderrBytes: stderr.length,
    safeStderr: failed ? context.redactText(stderr.toString("utf8")).slice(0, 4096) : "",
    stderrTruncated: stderrBytes > 8192, stdoutTruncated: stdoutBytes > 64 * 1024,
    spawnErrorKind: spawnError?.name ?? null, stopFailed: stopFailure !== null,
    remoteStageMarkers: stage.markers, invalidStageMarkerCount: stage.invalidMarkerCount,
    droppedStageMarkerCount: stage.droppedMarkerCount,
  };
  try { await context.writeArtifactJson(`routes-only-remote-read-${callId}-${remoteArtifactSlug(label)}.json`, evidence); } catch {}
  if (failed) throw new Error(`routes-only remote read failed: ${label}`);
  assert.ok(stdout.length > 0 && stdout.length < 64 * 1024, "sidecar base config must be bounded and non-empty");
  await context.writeArtifactJson(`routes-only-ssh-stage-${callId}-${remoteArtifactSlug(label)}.json`, {
    label, outcome: "completed", elapsedMs: performance.now() - startedAt,
    markers: stage.markers, invalidMarkerCount: stage.invalidMarkerCount, droppedMarkerCount: stage.droppedMarkerCount,
  });
  return stdout;
}

async function remoteOutput(context, label, command, timeoutMs = 30_000) {
  const callId = nextRemoteCallId();
  const processLabel = `ssh-${callId}-${remoteArtifactSlug(label).slice(0, 88)}`;
  const startedAt = performance.now();
  const maxStdoutBytes = 4 * 1024 * 1024, maxStderrBytes = 64 * 1024;
  const stdoutParts = [], stderrParts = [];
  let stdoutBytes = 0, stderrBytes = 0, stdoutTruncated = false, stderrTruncated = false;
  let closeInfo = null, spawnError = null, stopPromise = null;
  const stageObserver = createSshStageObserver(startedAt);
  const child = await context.spawnRemoteSsh(processLabel, command, {
    cwd: repoRoot, env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
  });
  child.once("error", error => { spawnError = error; });
  child.once("close", (code, signal) => { closeInfo = { code, signal }; });
  const requestStop = () => {
    if (!stopPromise) stopPromise = context.stopOwned(processLabel);
    return stopPromise;
  };
  const collect = (target, chunk, cap) => {
    const bytes = Buffer.from(chunk);
    if (target === "stdout") {
      stdoutBytes += bytes.length;
      if (!stdoutTruncated && stdoutBytes <= cap) stdoutParts.push(bytes);
      else { stdoutTruncated = true; void requestStop().catch(() => {}); }
    } else {
      stderrBytes += bytes.length;
      if (!stderrTruncated && stderrBytes <= cap) stderrParts.push(bytes);
      else { stderrTruncated = true; void requestStop().catch(() => {}); }
      stageObserver.push(bytes);
    }
  };
  child.stdout.on("data", chunk => collect("stdout", chunk, maxStdoutBytes));
  child.stderr.on("data", chunk => collect("stderr", chunk, maxStderrBytes));
  let waitFailure = null, stopFailure = null, terminalFailure = null;
  try { await waitFor(() => closeInfo !== null || spawnError !== null, timeoutMs, `remote command ${label}`, 25, context.abortSignal); }
  catch (error) { waitFailure = error; }
  try { await requestStop(); } catch (error) { stopFailure = error; }
  if (closeInfo === null) {
    try { await waitFor(() => closeInfo !== null, 5_000, `remote command terminal ${label}`, 25); }
    catch (error) { terminalFailure = error; }
  }
  const stdout = Buffer.concat(stdoutParts), stderr = Buffer.concat(stderrParts);
  const stage = stageObserver.finish();
  const expectedStageSequence = command.includes("KCUX_STAGE:REMOTE_PYTHON_ENTERED")
    ? ["REMOTE_PYTHON_ENTERED", "REMOTE_PROGRAM_COMPLETE"] : null;
  const stageSequence = stage.markers.map(marker => marker.stage);
  const stageSequenceMismatch = expectedStageSequence !== null &&
    JSON.stringify(stageSequence) !== JSON.stringify(expectedStageSequence);
  const failed = Boolean(waitFailure || stopFailure || terminalFailure || spawnError || stdoutTruncated || stderrTruncated ||
    !stage.valid || stageSequenceMismatch || closeInfo?.code !== 0);
  if (failed) {
    const text = `${stderr.toString("utf8")}\n${stdout.toString("utf8")}`;
    const evidence = {
      label, callId, processLabel, pid: child.pid ?? null,
      exitCode: closeInfo?.code ?? child.exitCode ?? null, signal: closeInfo?.signal ?? child.signalCode ?? null,
      terminalObserved: closeInfo !== null, timedOut: Boolean(waitFailure && /Timed out/.test(String(waitFailure.message))),
      aborted: Boolean(context.abortSignal?.aborted), elapsedMs: performance.now() - startedAt,
      stdoutBytes, stderrBytes, stdoutTruncated, stderrTruncated,
      safeOutput: context.redactText(text).slice(0, 4096), safeOutputTruncated: text.length > 4096,
      spawnErrorKind: spawnError?.name ?? null, terminalWaitFailed: terminalFailure !== null,
      stopFailed: stopFailure !== null, remoteStageMarkers: stage.markers,
      invalidStageMarkerCount: stage.invalidMarkerCount, droppedStageMarkerCount: stage.droppedMarkerCount,
      stageSequenceMismatch,
    };
    try { await context.writeArtifactJson(`routes-only-remote-failure-${callId}-${remoteArtifactSlug(label)}.json`, evidence); } catch {}
    throw new Error(`routes-only remote step failed: ${label}`);
  }
  await context.writeArtifactJson(`routes-only-ssh-stage-${callId}-${remoteArtifactSlug(label)}.json`, {
    label, outcome: "completed", elapsedMs: performance.now() - startedAt,
    markers: stage.markers, invalidMarkerCount: stage.invalidMarkerCount, droppedMarkerCount: stage.droppedMarkerCount,
    stageSequenceMismatch,
  });
  return stdout.toString("utf8").trimEnd();
}

function nextRemoteCallId() { remoteCallOrdinal += 1; return String(remoteCallOrdinal).padStart(5, "0"); }
function remoteArtifactSlug(value) { return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "remote"; }

async function sshWrite(context, label, command, data) {
  const startedAt = performance.now();
  const stageObserver = createSshStageObserver(startedAt);
  const child = await context.spawnRemoteSsh(label, command, {
    cwd: repoRoot, env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]), stdin: "pipe",
  });
  child.stderr.on("data", chunk => stageObserver.push(chunk));
  child.stdin.on("error", () => {}); child.stdin.end(data);
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 30_000, `owned SSH write ${label}`, 25, context.abortSignal);
  assert.equal(child.exitCode, 0, `owned SSH write failed: ${label}`);
  const stage = stageObserver.finish();
  assert.equal(stage.valid, true, "SSH write stage markers must be well-formed and bounded");
  if (command.includes("KCUX_STAGE:REMOTE_PYTHON_ENTERED")) {
    assert.deepEqual(stage.markers.map(marker => marker.stage), ["REMOTE_PYTHON_ENTERED", "REMOTE_PROGRAM_COMPLETE"]);
  }
  await context.writeArtifactJson(`routes-only-ssh-stage-${nextRemoteCallId()}-${remoteArtifactSlug(label)}.json`, {
    label, outcome: "completed", elapsedMs: performance.now() - startedAt,
    markers: stage.markers, invalidMarkerCount: stage.invalidMarkerCount, droppedMarkerCount: stage.droppedMarkerCount,
  });
}

function parseSha256Receipt(output) {
  if (typeof output !== "string") throw new Error("candidate config SHA receipt must be a string");
  const match = /^sha256=([a-f0-9]{64})$/.exec(output.trim());
  if (!match) throw new Error("candidate config SHA receipt has an invalid shape");
  return match[1];
}

function parseCandidatePidReceipt(output) {
  if (typeof output !== "string") throw new Error("candidate PID receipt must be a string");
  const match = /^candidatePid=([1-9][0-9]{0,9})$/.exec(output.trim());
  if (!match) throw new Error("candidate PID receipt has an invalid shape");
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("candidate PID receipt is outside the allowed range");
  return pid;
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
