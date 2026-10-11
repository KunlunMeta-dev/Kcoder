import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  chmod,
  cp,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { chromium as playwrightChromium } from "../../../renderer/node_modules/@playwright/test/index.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startOwnedDisplay } from "../../harness/ai-verify-gateway.mjs";
import { appRoot, repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { resolveExistingPrivateGatewaySnapshot, resolveExistingPrivatePath } from "./helpers/gateway-runtime-snapshot-guard.mjs";
import { createAcceptedTurnReceiptFixture, createResponseJitter, mobileApiPath, sanitizeGatewayPath, sumResponseDelayMs } from "./helpers/mobile-high-latency-fault-fixture.mjs";
import { findHttpResponseForRouteRequest } from "./helpers/refresh-http-response-correlation.mjs";
import { drainAndArmBackgroundHttpResponseHold } from "./helpers/refresh-background-window-visibility.mjs";
import { closeOwnedMobilePage, createRefreshProgressWriter, createTurnStartErrorFixtureFrame, observeOwnedMobilePage } from "./helpers/refresh-send-background-fixture.mjs";

const SERVER_ID = "backend4a";
const THREAD_ID = "mock-active-session";
const DEFAULT_SAMPLES = 30;
const DEFAULT_DELAYS = [0, 300, 600, 1000];
// Application-path timer/clock rounding tolerance; this is not network RTT.
const APPLICATION_DELAY_TIMER_TOLERANCE_MS = 1;
const SEND_ACK_HOLD_MS = 300;
const snapshotMode = optionValue("--snapshot", "before");
const snapshotDirectory = optionValue("--snapshot-dir", null);
const snapshotSourceSha256 = optionValue("--snapshot-source-sha256", null);
const beforeComplementDirectory = optionValue("--before-complement-dir", null);
const beforeComplementSha256 = optionValue("--before-complement-sha256", null);
const reuseExportDirectory = optionValue("--reuse-export-dir", null);
const reuseExportManifest = optionValue("--reuse-export-manifest", null);
const gatewaySnapshotDirectory = optionValue("--gateway-snapshot-dir", null);
const gatewayKcoderBinaryOverride = optionValue("--gateway-kcoder-bin", null);
const gatewayKcoderBinarySha256 = optionValue("--gateway-kcoder-sha256", null);
const navigationOnly = process.argv.includes("--navigation-only");
const drawerCloseDiagnosticsEnabled = process.argv.includes("--drawer-close-diagnostics");
const faultScenariosOnly = process.argv.includes("--fault-scenarios");
const selectedFaultScenario = optionValue("--fault-scenario", null);
const refreshSmokeMode = process.argv.includes("--refresh-smoke");
const refreshAuthCleanupUiGateCycles = optionValue("--auth-cleanup-ui-gate", null);
const refreshAuthCleanupUiGateMode = refreshAuthCleanupUiGateCycles !== null;
const refreshSendDiagnostic = optionValue("--refresh-send-diagnostic", null);
const refreshSendDiagnosticMode = refreshSendDiagnostic === "accepted-600";
const refreshBackgroundDiagnostic = optionValue("--refresh-background-diagnostic", null);
const refreshBackgroundDiagnosticMode = refreshBackgroundDiagnostic === "home-600";
const refreshDiagnosticMode = refreshSendDiagnosticMode || refreshBackgroundDiagnosticMode;
const refreshBackgroundWindowMode = !refreshSendDiagnosticMode && !refreshAuthCleanupUiGateMode;
const refreshSingleSampleMode = refreshSmokeMode || refreshDiagnosticMode || refreshAuthCleanupUiGateMode;
const formalOwnedAuthLifecycle = !refreshSingleSampleMode;
const refreshCoverageMode = refreshDiagnosticMode
  ? "DIAGNOSTIC_ONLY"
  : refreshSmokeMode ? "SMOKE_ONLY" : refreshAuthCleanupUiGateMode ? "AUTH_CLEANUP_UI_GATE_ONLY" : "FORMAL_N30";
const REFRESH_AUTH_CLEANUP_UI_GATE_CYCLES = 35;
const REFRESH_R7_INPUT_ROOT = resolve(repoRoot, "target/private-phone-ux-implementation/owned-openbox-input-20261008T085548Z");
const REFRESH_R7_OPENBOX_PATH = resolve(REFRESH_R7_INPUT_ROOT, "prefix/usr/bin/openbox");
const REFRESH_R7_OPENBOX_SHA256 = "941e69bf5479d77805bdeae7a6dee17142ff429b8db9e7d0c1b579e9c70a0b52";
const REFRESH_R7_OPENBOX_LIB_DIR = resolve(REFRESH_R7_INPUT_ROOT, "prefix/usr/lib/x86_64-linux-gnu");
const REFRESH_R7_OPENBOX_LOADER_DIR = resolve(REFRESH_R7_OPENBOX_LIB_DIR, "imlib2/loaders");
const REFRESH_R7_OPENBOX_FILTER_DIR = resolve(REFRESH_R7_OPENBOX_LIB_DIR, "imlib2/filters");
const REFRESH_R7_OPENBOX_RC_PATH = resolve(REFRESH_R7_INPUT_ROOT, "prefix/etc/xdg/openbox/rc.xml");
const REFRESH_R7_OPENBOX_RC_SHA256 = "dc4906ce83e6130a4f622871039a80d872d3b3bc72030bc887f2fbe73bbfd38f";
const REFRESH_BACKGROUND_HOOK_HELPER_PATH = resolve(appRoot, "e2e/suites/mobile/helpers/refresh-background-window-visibility.mjs");
const REFRESH_BACKGROUND_HOOK_HELPER_SHA256 = "81f27fb753cdf0e677845e5bc9c8ac203b5ec2c06d3dda0487800e4b1ce63f8b";
const REFRESH_R7_XVFB_PATH = "/usr/bin/Xvfb";
const REFRESH_R7_XVFB_SHA256 = "2c7f5a9534410fed5092d782a69ca7ffd9fce80e98b81ffe4944d703dd11d3b1";
const REFRESH_R7_CHROMIUM_PATH = "/usr/bin/chromium";
const REFRESH_R7_CHROMIUM_REALPATH = "/opt/cft/chrome-linux64/chrome";
const REFRESH_R7_CHROMIUM_SHA256 = "0b20b130e7edd9dd51873be867761295fe0cfad490c2b9a64f95bd3cfc08fa71";
const REFRESH_R7_NODE_REALPATH = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const REFRESH_R7_NODE_SHA256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const REFRESH_R7_PLAYWRIGHT_TEST_ENTRY = resolve(appRoot, "renderer/node_modules/.pnpm/@playwright+test@1.62.0/node_modules/@playwright/test/index.mjs");
const REFRESH_R7_PLAYWRIGHT_TEST_ENTRY_SHA256 = "ec8997c2e5cea26befc76e7bf990750e96babb16977673a9ff3b5c0575d01e48";
const REFRESH_R7_PLAYWRIGHT_CORE_PACKAGE = resolve(appRoot, "renderer/node_modules/.pnpm/playwright-core@1.62.0/node_modules/playwright-core/package.json");
const REFRESH_R7_PLAYWRIGHT_CORE_PACKAGE_SHA256 = "4556ebbf21a31c5e8dabb49c991ec291c5f00ffcad8b18cda45e4070b8a473bd";
const REFRESH_R7_MOBILE_METRICS = Object.freeze({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
const REFRESH_R7_TOUCH = Object.freeze({ enabled: true, maxTouchPoints: 1 });
const REFRESH_BACKGROUND_MOBILE_SESSIONS = new WeakMap();
const REFRESH_BACKGROUND_WINDOW_HOSTS = new WeakMap();
const refreshScenarioId = "refresh-send-background-return-n30";
const faultScenarioIds = [
  "slow-status-12s",
  "status-http-401",
  "runtime-model-catalog-slow-12s",
  "aux-agent-list-12s",
  "send-pending-2500ms",
  "approval-live-turn-interrupt-same-route",
  "ack-loss-reconnect-exact-receipt",
  "websocket-disconnect-and-reconnect",
  "response-jitter-30",
  "refresh-send-background-return-n30",
];
const sampleCount = Number(optionValue("--samples", String(DEFAULT_SAMPLES)));
const delayValues = optionValue("--delay", DEFAULT_DELAYS.join(","))
  .split(",")
  .map(value => Number(value.trim()));

assert.ok(["before", "after"].includes(snapshotMode), "--snapshot must be before or after");
assert.equal(Boolean(beforeComplementDirectory), Boolean(beforeComplementSha256), "--before-complement-dir and --before-complement-sha256 must be supplied together");
assert.ok(snapshotMode === "before" || !beforeComplementDirectory, "--before-complement-dir may only be used with --snapshot=before");
if (beforeComplementSha256 !== null) assert.match(beforeComplementSha256, /^[a-f0-9]{64}$/, "--before-complement-sha256 must be a lowercase SHA-256 digest");
assert.ok(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 100, "--samples must be between 1 and 100");
assert.ok(delayValues.length > 0 && delayValues.every(value => Number.isInteger(value) && value >= 0 && value <= 10_000), "--delay must be a comma-separated list of non-negative milliseconds");
assert.equal(Boolean(gatewayKcoderBinaryOverride), Boolean(gatewayKcoderBinarySha256), "--gateway-kcoder-bin and --gateway-kcoder-sha256 must be supplied together");
assert.ok(selectedFaultScenario === null || (faultScenariosOnly && faultScenarioIds.includes(selectedFaultScenario)), "--fault-scenario must select a known scenario with --fault-scenarios");
assert.equal(faultScenariosOnly, true, "the refresh/send/background entry requires --fault-scenarios");
assert.equal(selectedFaultScenario, refreshScenarioId, "the refresh/send/background entry requires its named scenario before resource startup");
assert.ok(refreshSendDiagnostic === null || refreshSendDiagnostic === "accepted-600", "--refresh-send-diagnostic only accepts accepted-600");
assert.ok(refreshBackgroundDiagnostic === null || refreshBackgroundDiagnostic === "home-600", "--refresh-background-diagnostic only accepts home-600");
assert.ok(!(refreshSendDiagnostic && refreshBackgroundDiagnostic), "accepted-send and background diagnostics cannot be combined");
assert.ok(refreshAuthCleanupUiGateCycles === null || refreshAuthCleanupUiGateCycles === String(REFRESH_AUTH_CLEANUP_UI_GATE_CYCLES), `--auth-cleanup-ui-gate only accepts ${REFRESH_AUTH_CLEANUP_UI_GATE_CYCLES}`);
if (refreshAuthCleanupUiGateMode) {
  assert.equal(faultScenariosOnly, true, "auth cleanup UI gate requires --fault-scenarios");
  assert.equal(selectedFaultScenario, refreshScenarioId, "auth cleanup UI gate requires the refresh/send/background scenario");
  assert.equal(refreshSmokeMode, false, "auth cleanup UI gate cannot be combined with --refresh-smoke");
  assert.equal(refreshDiagnosticMode, false, "auth cleanup UI gate cannot be combined with a latency diagnostic");
  assert.equal(navigationOnly, false, "auth cleanup UI gate cannot be combined with --navigation-only");
  assert.equal(drawerCloseDiagnosticsEnabled, false, "auth cleanup UI gate cannot be combined with drawer-close diagnostics");
  assert.equal(sampleCount, 1, "auth cleanup UI gate uses a fixed 35-cycle lifecycle and requires --samples=1");
  assert.deepEqual(delayValues, [0], "auth cleanup UI gate requires --delay=0; it does not measure latency");
  assert.equal(snapshotMode, "after", "auth cleanup UI gate requires the latest explicitly frozen after snapshot");
  assert.ok(snapshotDirectory && snapshotSourceSha256 && reuseExportDirectory && reuseExportManifest, "auth cleanup UI gate requires pinned after-source and reused-web-export inputs");
} else if (refreshSendDiagnosticMode) {
  assert.equal(faultScenariosOnly, true, "accepted-600 diagnostic requires --fault-scenarios");
  assert.equal(selectedFaultScenario, refreshScenarioId, "accepted-600 diagnostic requires the refresh/send/background scenario");
  assert.equal(refreshSmokeMode, false, "accepted-600 diagnostic cannot be combined with the zero-delay refresh smoke");
  assert.equal(sampleCount, 1, "accepted-600 diagnostic requires exactly one sample for one action");
  assert.deepEqual(delayValues, [600], "accepted-600 diagnostic requires only the 600ms response hold");
} else if (refreshSmokeMode) {
  assert.equal(faultScenariosOnly, true, "--refresh-smoke requires --fault-scenarios");
  assert.equal(selectedFaultScenario, refreshScenarioId, "--refresh-smoke requires --fault-scenario=refresh-send-background-return-n30");
  assert.equal(sampleCount, 1, "--refresh-smoke requires exactly one sample per action");
  assert.deepEqual(delayValues, [0], "--refresh-smoke requires only the zero-delay functional check");
} else if (refreshBackgroundDiagnosticMode) {
  assert.equal(faultScenariosOnly, true, "home-600 diagnostic requires --fault-scenarios");
  assert.equal(selectedFaultScenario, refreshScenarioId, "home-600 diagnostic requires the refresh/send/background scenario");
  assert.equal(refreshSmokeMode, false, "home-600 diagnostic cannot be combined with the zero-delay refresh smoke");
  assert.equal(refreshSendDiagnosticMode, false, "home-600 diagnostic cannot be combined with the accepted-send diagnostic");
  assert.equal(sampleCount, 1, "home-600 diagnostic requires one sample");
  assert.deepEqual(delayValues, [600], "home-600 diagnostic requires only the 600ms HTTP response hold");
  assert.equal(snapshotMode, "after", "home-600 diagnostic requires the latest explicitly frozen after snapshot");
  assert.ok(snapshotDirectory && snapshotSourceSha256 && reuseExportDirectory && reuseExportManifest, "home-600 diagnostic requires pinned after-source and reused-web-export inputs");
} else if (faultScenariosOnly && (selectedFaultScenario === null || selectedFaultScenario === refreshScenarioId)) {
  assert.equal(sampleCount, DEFAULT_SAMPLES, "the refresh/send/background scenario requires n=30 unless --refresh-smoke is explicit");
  assert.deepEqual(delayValues, DEFAULT_DELAYS, "the formal refresh/send/background scenario requires the 0/300/600/1000ms delay bins");
}

await runE2E(import.meta.url, {
  testId: "mobile-ux-refresh-send-background-candidate",
  tier: "manual-live",
  modelPolicy: "real Mobile Web UI through isolated KCODER_STUDIO_MOCK; background samples use a fresh owned Chromium default context with trusted real-window visibility, send samples use fresh BrowserContexts; explicit accepted-600 diagnostic, zero-delay all-action smoke, 35-cycle fresh-context auth-cleanup gate, and formal n30 modes are separately gated; no real Provider or native claim",
  retainSuccessLogs: true,
}, async context => {
  const currentMobileRoot = resolve(appRoot, "mobile");
  const currentSharedRoot = resolve(appRoot, "shared");
  const launcherSourceDigestBefore = sha256(await readFile(new URL(import.meta.url)));
  const gatewayRuntime = await prepareGatewayRuntimeSnapshot(context, gatewaySnapshotDirectory, gatewayKcoderBinaryOverride, gatewayKcoderBinarySha256);
  const gatewayRuntimeBefore = await inspectGatewayRuntimeSnapshot(gatewayRuntime.root, gatewayKcoderBinaryOverride);
  const beforeComplementHash = snapshotMode === "before" && !beforeComplementDirectory ? await hashComplement(currentMobileRoot, currentSharedRoot) : null;
  const sourceSnapshot = await prepareSnapshot(context, snapshotMode, currentMobileRoot, currentSharedRoot, snapshotDirectory, snapshotSourceSha256, beforeComplementDirectory, beforeComplementSha256);
  const afterComplementHash = snapshotMode === "before" && !beforeComplementDirectory ? await hashComplement(currentMobileRoot, currentSharedRoot) : null;
  if (snapshotMode === "before" && !beforeComplementDirectory) assert.equal(afterComplementHash, beforeComplementHash, "Mobile/shared complement changed while the frozen source copy was being prepared");
  const dependencySnapshot = reuseExportDirectory ? null : await createDependencySnapshot(context, currentMobileRoot);

  const mobileWeb = reuseExportDirectory
    ? await reuseMobileWebExport(context, sourceSnapshot, reuseExportDirectory, reuseExportManifest)
    : await exportMobileWeb(context, {
      mobileRoot: sourceSnapshot.mobileRoot,
      sourceRoots: [
        { name: "mobile", path: sourceSnapshot.mobileRoot, destination: "apps/kcoder-studio/mobile" },
        { name: "studio-shared", path: sourceSnapshot.sharedRoot, destination: "apps/kcoder-studio/shared" },
      ],
      dependencyRoot: dependencySnapshot.path,
      label: `mobile-high-latency-${snapshotMode}`,
      outputName: `mobile-high-latency-${snapshotMode}-web-export`,
    });
  const exportedWebArtifact = context.pathInArtifacts("mobile-web-export");
  await copyArtifactTree(mobileWeb.path, exportedWebArtifact);

  const workspace = context.pathInState("isolated-workspace");
  await mkdir(workspace, { recursive: true });
  const serversFile = await context.writeStateJson("mock-servers.json", [{
    id: SERVER_ID,
    label: "Backend 4A fixture",
    runtime: "kcoder",
    transport: "local",
    command: process.execPath,
    workspace,
  }]);
  const serversStore = context.pathInState("gateway-servers-store.json");
  const gateway = await startFrozenGateway(context, gatewayRuntime, {
    label: "phone-ux-isolated-gateway",
    workspace,
    serversFile,
    serversStore,
    webRoot: mobileWeb.path,
    mock: true,
  });
  const refreshBackgroundHost = refreshBackgroundWindowMode
    ? await startRefreshBackgroundChromium(context, { hostOnly: true })
    : null;
  const chromium = refreshBackgroundDiagnosticMode
    ? await startRefreshBackgroundChromium(context, { host: refreshBackgroundHost, instanceKey: "home-600-diagnostic" })
    : await startChromium(context, {
      label: "phone-ux-mobile-chromium",
      noSandbox: true,
    });
  const refreshDiagnosticBrowserContext = refreshBackgroundDiagnosticMode
    ? await requireOwnedDefaultBrowserContext(chromium.browser)
    : null;
  if (refreshBackgroundDiagnosticMode) assert.equal(refreshDiagnosticBrowserContext, chromium.defaultContext, "first noDefaults context identity changed before the Mobile fixture");

  const observations = [];
  const network = createNetworkLedger();
  const browserErrors = [];
  const gatewayCalls = { turnStart: 0, modelCatalogRpcRequests: 0 };

  if (faultScenariosOnly) {
    if (refreshAuthCleanupUiGateMode) {
      const authCleanupGate = await runFreshAuthCleanupUiGate(
        chromium,
        gateway,
        network,
        gatewayCalls,
        browserErrors,
        context,
        REFRESH_AUTH_CLEANUP_UI_GATE_CYCLES,
      );
      await waitForGatewayRpcQuiescence(network, 15_000, 100);
      network.currentStage = "auth-cleanup-ui-gate-complete";
      network.currentActionId = "auth-cleanup-ui-gate-complete";
      const networkSnapshot = snapshotNetworkEvidence(network);
      const pendingAtSnapshot = pendingGatewayActivity(networkSnapshot);
      const gatewayRuntimeAfter = await inspectGatewayRuntimeSnapshot(gatewayRuntime.root, gatewayKcoderBinaryOverride);
      const launcherSourceDigestAfter = sha256(await readFile(new URL(import.meta.url)));
      const gatewayRuntimeUnchanged = gatewayRuntimeStable(gatewayRuntimeBefore, gatewayRuntimeAfter);
      const sourceUnchanged = launcherSourceDigestAfter === launcherSourceDigestBefore;
      const gatePassed = authCleanupGate.status === "PASS"
        && pendingAtSnapshot.total === 0
        && browserErrors.length === 0
        && networkSnapshot.websocketForwardErrors === 0
        && gatewayCalls.turnStart === 0
        && gatewayRuntimeUnchanged
        && sourceUnchanged;
      await context.writeArtifactJson("phone-ux-refresh-auth-cleanup-ui-gate.json", {
        schemaVersion: 1,
        gateId: "refresh-send-background-auth-cleanup-35-fresh-ui-contexts",
        status: gatePassed ? "PASS" : "FAIL",
        coverageMode: "AUTH_CLEANUP_UI_GATE_ONLY",
        formalN30Coverage: false,
        evidenceClass: "real Mobile Web UI pairing through isolated KCODER_STUDIO_MOCK Gateway; no real Provider, public Gateway, or native claim",
        sampleClassification: "35 sequential fresh BrowserContexts; exact self-device revoke, web logout, stale-cookie 401 and active-grant zero gates; not a latency sample",
        cycles: authCleanupGate,
        noRealProviderRequests: true,
        gatewayCalls,
        browserErrors,
        network: summarizeNetwork(networkSnapshot),
        pendingAtSnapshot,
        launcherSource: {
          sha256Before: launcherSourceDigestBefore,
          sha256After: launcherSourceDigestAfter,
          unchangedDuringRun: sourceUnchanged,
        },
        frozenSource: {
          snapshotRoot: relative(repoRoot, sourceSnapshot.snapshotRoot),
          manifestSha256: sourceSnapshot.manifestSha256,
          freezeMetadataSha256: sourceSnapshot.freezeMetadataSha256,
          sourceDigest: sourceSnapshot.frozenSourceDigest,
          entryCount: sourceSnapshot.entryCount,
          completeness: sourceSnapshot.completeness,
        },
        mobileWeb: {
          sourceTreeSha256: mobileWeb.sourceTreeSha256,
          bundleSha256: mobileWeb.bundleSha256,
          bundleManifestPath: relative(context.runRoot, mobileWeb.bundleManifestPath),
          dependencySourceTreeSha256: mobileWeb.dependencySourceTreeSha256,
          dependencyOwnedTreeSha256: mobileWeb.dependencyOwnedTreeSha256,
          reuseValidation: mobileWeb.reuseValidation ?? null,
        },
        gatewayRuntime: {
          root: relative(repoRoot, gatewayRuntime.root),
          manifest: relative(repoRoot, gatewayRuntime.manifestPath),
          manifestSha256: gatewayRuntime.manifestSha256,
          sourceTreeSha256: gatewayRuntimeBefore.sourceDigest,
          dependencyTreeSha256: gatewayRuntimeBefore.dependencyDigest,
          nodeExecutable: gatewayRuntimeBefore.nodeExecutable,
          nodeVersion: gatewayRuntimeBefore.nodeVersion,
          binarySha256: gatewayRuntimeBefore.kcoderBinarySha256,
          unchangedDuringRun: gatewayRuntimeUnchanged,
        },
        browser: {
          version: await chromium.browser.version(),
          executablePath: basename(chromium.executablePath),
          viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
          evidenceBoundary: "owned Chromium Mobile Web contexts against an isolated mock Gateway; does not represent native Android/iOS or public relay auth",
        },
        gateway: { port: gateway.port, pid: gateway.child.pid, mock: true, isolatedWorkspace: true },
      });
      assert.equal(gatePassed, true, "35-cycle fresh UI auth cleanup gate must pass every pair/revoke/logout/stale-cookie/zero-active hard gate");
      return;
    }

    const faultScenarios = await runPhoneUxFaultScenarios(chromium, gateway, network, gatewayCalls, browserErrors, context, refreshBackgroundHost);
    const refreshSendCoverageStatus = faultScenarios.rows.find(row => row.scenario === "refresh-send-background-return-n30")?.checks?.coverageStatus ?? null;
    await waitForGatewayRpcQuiescence(network);
    network.currentStage = "fault-scenarios-complete";
    const networkSnapshot = snapshotNetworkEvidence(network);
    const pendingAtSnapshot = pendingGatewayActivity(networkSnapshot);
    assert.equal(pendingAtSnapshot.total, 0, `fault-scenario provenance must not be captured with undrained work: ${JSON.stringify(pendingAtSnapshot)}`);
    const gatewayRuntimeAfter = await inspectGatewayRuntimeSnapshot(gatewayRuntime.root, gatewayKcoderBinaryOverride);
    const launcherSourceDigestAfter = sha256(await readFile(new URL(import.meta.url)));
    assert.equal(launcherSourceDigestAfter, launcherSourceDigestBefore, "fault E2E launcher source changed during the run");
    assert.equal(gatewayRuntimeStable(gatewayRuntimeBefore, gatewayRuntimeAfter), true, "frozen Gateway runtime inputs changed during the fault scenario");
    await context.writeArtifactJson("phone-ux-fault-scenarios.json", {
      schemaVersion: 1,
      scenarioSubsetStatus: faultScenarios.requiredScenarioFailures.length > 0
        ? "FAIL"
        : refreshDiagnosticMode && refreshSendCoverageStatus === "DIAGNOSTIC_ONLY" ? "DIAGNOSTIC_ONLY"
          : refreshSmokeMode && refreshSendCoverageStatus === "SMOKE" ? "SMOKE_ONLY"
          : refreshSendCoverageStatus && refreshSendCoverageStatus !== "PASS" ? "PARTIAL" : "PASS",
      selectedScenario: selectedFaultScenario ?? "all-required-fault-scenarios",
      scenarioScope: selectedFaultScenario ? "single named fault scenario only; not full matrix completion" : "all required fault scenarios",
      fullPlanStatus: "PARTIAL",
      mode: "isolated Mobile Web / KCODER_STUDIO_MOCK Gateway; browser-level HTTP/WSS response fixtures; no model provider",
      sampleClassification: refreshSendDiagnosticMode
        ? "single accepted-send functional diagnostic with a 600ms mock ACK hold; no percentile or formal n=30 claim"
        : refreshBackgroundDiagnosticMode
          ? "single home background/foreground diagnostic with a 600ms mock /api/servers response hold; no percentile or formal n=30 claim"
        : "functional scenario evidence only; no P50/P95 claim unless a scenario explicitly records 30 complete samples",
      refreshCoverageMode: refreshSendDiagnosticMode
        ? "DIAGNOSTIC_ONLY; one accepted-send sample at a 600ms mock ACK hold; excluded from formal n=30 coverage"
        : refreshBackgroundDiagnosticMode
          ? "DIAGNOSTIC_ONLY; one home resume refresh sample at a 600ms mock /api/servers hold using actual owned-window minimize/restore and trusted visibility; excluded from formal n=30 coverage"
        : refreshSmokeMode ? "SMOKE_ONLY; one sample per action at zero delay; not formal n=30 coverage" : "FORMAL_N30",
      faults: faultScenarios.rows,
      requiredScenarioFailures: faultScenarios.requiredScenarioFailures,
      fixtureReceiptLedger: faultScenarios.fixtureReceiptLedger,
      coverageLedger: [
        { id: "slow-server-status-probe-12s", status: scenarioStatus(faultScenarios.rows, "slow-status-12s") },
        { id: "slow-auxiliary-agent-list-12s-history-first", status: scenarioStatus(faultScenarios.rows, "aux-agent-list-12s") },
        {
          id: "endpoint-specific-status-probe-401-reauthorization-and-cold-resume-block",
          status: scenarioStatus(faultScenarios.rows, "status-http-401"),
          evidenceBoundary: "browser route override for /api/servers/status only; does not revoke a Gateway token or prove session-expiry behavior",
        },
        { id: "send-local-pending-before-mock-ack", status: scenarioStatus(faultScenarios.rows, "send-pending-2500ms") },
        { id: "drop-ack-reconnect-exact-thread-clientMessageId-readback", status: scenarioStatus(faultScenarios.rows, "ack-loss-reconnect-exact-receipt"), evidenceBoundary: "isolated mock in-memory receipt only; no durable Rust receipt proof" },
        { id: "same-route-interrupt-live-approval-turn-terminal", status: scenarioStatus(faultScenarios.rows, "approval-live-turn-interrupt-same-route"), evidenceBoundary: "MOBILE_APPROVAL holds the isolated mock turn; proves same-route UI interrupt only" },
        { id: "cross-route-stop-after-ack-loss", status: "UNVERIFIED", reason: "the isolated mock owns activeTurn on the original route socket; reconnect receipt readback runs on a replacement route and cannot prove real resident-runtime cross-route interruption" },
        { id: "forced-websocket-close-and-reconnect", status: scenarioStatus(faultScenarios.rows, "websocket-disconnect-and-reconnect"), evidenceBoundary: "Playwright WebSocket route close, not IP/TCP packet loss" },
        { id: "deterministic-http-ws-response-jitter-30-plus", status: scenarioStatus(faultScenarios.rows, "response-jitter-30") },
        {
          id: "refresh-send-background-return-n30",
          status: faultScenarios.rows.find(row => row.scenario === "refresh-send-background-return-n30")?.checks?.coverageStatus ?? "NOT_RUN",
          evidenceBoundary: "serial Mobile Web scenarios through KCODER_STUDIO_MOCK; background counts require actual trusted visibility transitions and post-active route requests; rejected-send branch injects a correlated JSON-RPC error at the Playwright WebSocket route and does not prove Rust app-server rejection",
        },
        { id: "runtime-model-catalog-slow-12s", status: scenarioStatus(faultScenarios.rows, "runtime-model-catalog-slow-12s"), evidenceBoundary: "typed mock thread model fixture plus real UI-persisted workspace model/effort preference; no model Provider request" },
        { id: "50-500-2000-message-history-matrix", status: "NOT_RUN", reason: "separate render/history profile coverage; this fault subset does not create large histories" },
        { id: "gateway-session-delete-revoke-or-principal-expiry", status: "NOT_RUN", reason: "requires an isolated Gateway session DELETE/revoke contract; the status endpoint override does not mutate authentication state" },
        { id: "hot-task-cache-readable-after-auth-revocation", status: "NOT_RUN", reason: "reauthorization routeError currently intercepts TaskScreen before cached transcript display; product behavior is recorded for a separate decision, not inferred from a cold route" },
        { id: "real-network-rtt-loss-or-mobile-radio", status: "UNVERIFIED", reason: "fixture delays HTTP/WSS application responses; it is not packet shaping or physical RTT" },
        { id: "native-android-ios-keyboard-and-webview", status: "UNVERIFIED", reason: "this suite runs Chromium mobile viewport only" },
        { id: "real-model-first-frame", status: "UNVERIFIED", reason: "no model provider is configured or invoked" },
      ],
      network: summarizeNetwork(networkSnapshot),
      browserErrors,
      gatewayCalls,
      evidenceBoundaries: {
        http401: "endpoint-specific /api/servers/status route override; verifies the reauthorization UI and cold task-resume guard only, not token revocation, principal expiry, or public Relay authorization",
        websocketDisconnect: "Playwright WebSocket route close; not packet loss or native transport behavior",
        turnReceiptReadback: "in-memory fixture receipt populated only from an observed successful isolated mock turn/start response; not durable Rust app-server receipt evidence",
        jitter: "deterministic extra delay on application HTTP/WSS response paths; not RTT, TCP loss, or a real mobile network profile",
        platform: "Chromium mobile viewport only; native Android/iOS and keyboard remain UNVERIFIED",
      },
    });
    await context.writeArtifactJson("phone-ux-fault-provenance.json", {
      schemaVersion: 1,
      evidenceKind: "isolated Mobile Web fault-scenario runtime provenance",
      snapshotMode,
      scenarioScope: selectedFaultScenario ? `single named scenario: ${selectedFaultScenario}` : "all required fault scenarios",
      fullPlanStatus: "PARTIAL",
      gitCommit: context.gitCommit,
      frozenSource: {
        snapshotRoot: relative(repoRoot, sourceSnapshot.snapshotRoot),
        manifestSha256: sourceSnapshot.manifestSha256,
        freezeMetadataSha256: sourceSnapshot.freezeMetadataSha256,
        sourceDigest: sourceSnapshot.frozenSourceDigest,
        entryCount: sourceSnapshot.entryCount,
        overlaySha256: sourceSnapshot.overlaySha256,
        complementSha256: sourceSnapshot.complementSha256,
        completeness: sourceSnapshot.completeness,
        excludedContentCounts: sourceSnapshot.excludedContentCounts,
      },
      launcherSource: {
        sha256Before: launcherSourceDigestBefore,
        sha256After: launcherSourceDigestAfter,
        unchangedDuringRun: true,
      },
      mobileWeb: {
        sourceTreeSha256: mobileWeb.sourceTreeSha256,
        bundleSha256: mobileWeb.bundleSha256,
        bundleManifestPath: relative(context.runRoot, mobileWeb.bundleManifestPath),
        dependencySourceTreeSha256: mobileWeb.dependencySourceTreeSha256,
        dependencyOwnedTreeSha256: mobileWeb.dependencyOwnedTreeSha256,
        reuseValidation: mobileWeb.reuseValidation ?? null,
      },
      gatewayRuntime: {
        root: relative(repoRoot, gatewayRuntime.root),
        manifest: relative(repoRoot, gatewayRuntime.manifestPath),
        manifestSha256: gatewayRuntime.manifestSha256,
        sourceTreeSha256: gatewayRuntimeBefore.sourceDigest,
        dependencyTreeSha256: gatewayRuntimeBefore.dependencyDigest,
        nodeExecutable: gatewayRuntimeBefore.nodeExecutable,
        nodeVersion: gatewayRuntimeBefore.nodeVersion,
        binaryPath: relative(repoRoot, gatewayRuntime.binaryPath || gatewayRuntime.manifest.runtimeInputs.kcoderBinaryPath),
        binarySha256: gatewayRuntimeBefore.kcoderBinarySha256,
        runtimeStableDuringRun: true,
      },
      browser: {
        version: await chromium.browser.version(),
        executablePath: basename(chromium.executablePath),
        viewport: refreshBackgroundDiagnosticMode
          ? { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }
          : { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
        noDefaults: chromium.noDefaults === true,
        defaultBrowserContextCount: refreshBackgroundDiagnosticMode ? chromium.browser.contexts().length : null,
        evidenceBoundary: refreshBackgroundDiagnosticMode
          ? "real Mobile Web UI in owned headful Xvfb/Openbox Chromium; first and only CDP attach noDefaults; isolated KCODER_STUDIO_MOCK Gateway; not native Android/iOS"
          : "Chromium mobile viewport emulation; not native Android/iOS profiling",
      },
      gateway: { port: gateway.port, pid: gateway.child.pid, mock: true, isolatedWorkspace: true },
      noRealProviderRequests: true,
      gatewayCalls,
      pendingAtSnapshot,
      applicationDelayBoundary: "HTTP and WebSocket application response-path holds, not RTT, packet shaping, or native radio behavior",
    });
    assert.equal(faultScenarios.requiredScenarioFailures.length, 0, "required phone UX fault scenarios must pass; see phone-ux-fault-scenarios.json");
    assert.equal(browserErrors.length, 0, "fault scenarios must not cause uncaught Mobile Web page errors");
    assert.equal(networkSnapshot.websocketForwardErrors, 0, "fault scenario WebSocket fixtures must not lose forwarding tasks unexpectedly");
    return;
  }

  for (const delayMs of delayValues) {
    const hotPage = await newMobilePage(chromium, network, {
      delayMs,
      methodResponseHoldMs: { "turn/start": SEND_ACK_HOLD_MS },
    }, gatewayCalls, browserErrors, context);
    const profileSetupCapture = beginNavigationSampleCapture(network, observations, browserErrors, delayMs, "profile-setup", 0);
    const firstAccessStarted = performance.now();
    await connectMobile(hotPage, gateway);
    const warmProfileStorageState = await hotPage.context().storageState();
    observations.push({
      action: "first-profile-token-exchange-and-home",
      cacheClass: "fresh-browser-context",
      delayMs,
      durationMs: round(performance.now() - firstAccessStarted),
      ok: true,
      samples: 1,
      timingBoundary: "browser navigation through first Gateway profile setup; reported separately from repeated runtime samples",
    });
    await writeNavigationSampleCheckpoint(context, network, profileSetupCapture, observations, browserErrors);

    for (let index = 0; index < sampleCount; index += 1) {
      const sampleCapture = beginNavigationSampleCapture(network, observations, browserErrors, delayMs, "cold-runtime-warm-profile", index + 1);
      const page = await newMobilePage(chromium, network, {
        delayMs,
        methodResponseHoldMs: { "turn/start": SEND_ACK_HOLD_MS },
      }, gatewayCalls, browserErrors, context, warmProfileStorageState);
      const coldLoadStarted = performance.now();
      const loadResponse = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      assert.equal(loadResponse?.status(), 200, "warm-profile fresh runtime should load the isolated Gateway");
      await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 60_000 });
      await ensureFixtureSessionVisible(page);
      observations.push({
        action: "profile-restored-home",
        cacheClass: "cold-runtime-warm-profile",
        delayMs,
        durationMs: round(performance.now() - coldLoadStarted),
        ok: true,
        timingBoundary: "fresh BrowserContext with in-memory runtime cold and private auth/profile storageState restored",
      });
      await waitForGatewayRpcQuiescence(network);
      const closedDrawerThreadListBaseline = threadListRpcCount(network.rpcMethodCounts);
      network.currentStage = "cold-runtime-task-entry-to-drawer-open";
      await measureClick(page, observations, {
        action: "composer-ready",
        cacheClass: "cold-runtime-warm-profile",
        delayMs,
        sourceSelector: `[data-testid="thread-${THREAD_ID}"]`,
        targetSelector: '[data-testid="message-input-root"]',
        targetVisible: true,
        additionalTargets: [
          { action: "task-shell-title-visible", targetSelector: '[data-testid="task-header-title"]', targetVisible: true },
          { action: "history-first-content-visible", targetSelector: '[data-testid="message-user"]', targetVisible: true },
        ],
        click: () => page.getByTestId(`thread-${THREAD_ID}`).click(),
        wait: () => page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 60_000 }),
      }, context, network);
      network.currentStage = `${snapshotMode}:${"cold-runtime-warm-profile"}:task-interactive-closed-drawer`;
      await delay(100);
      network.drawerClosedListChecks.push({
        cacheClass: "cold-runtime-warm-profile",
        delayMs,
        requestsAfterTaskEntryBeforeDrawerOpen: Math.max(0, threadListRpcCount(network.rpcMethodCounts) - closedDrawerThreadListBaseline),
      });
      if (snapshotMode === "after") assert.equal(network.drawerClosedListChecks.at(-1).requestsAfterTaskEntryBeforeDrawerOpen, 0, "task entry with the drawer closed must not issue thread/list requests");
      await measureDrawerAndInput(page, observations, delayMs, "cold-runtime-warm-profile", index, network, snapshotMode, context, navigationOnly);
      await measureClick(page, observations, {
        action: "return-home",
        cacheClass: "cold-runtime-warm-profile",
        delayMs,
        sourceSelector: '[aria-label="返回"]',
        targetSelector: '[data-testid="new-workspace"]',
        targetVisible: true,
        click: () => page.getByLabel("返回", { exact: true }).click(),
        wait: () => page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 }),
      }, context, network);
      const refreshStarted = performance.now();
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 60_000 });
      await ensureFixtureSessionVisible(page);
      await waitForGatewayRpcQuiescence(network);
      observations.push({
        action: "refresh-home",
        cacheClass: "cold-runtime-warm-profile",
        delayMs,
        durationMs: round(performance.now() - refreshStarted),
        ok: true,
        timingBoundary: "navigation start through restored home and fixture session row",
      });
      await collectPreShimNativeWebSocketEvidence(page, network);
      await closeOwnedMobilePage(page);
      await writeNavigationSampleCheckpoint(context, network, sampleCapture, observations, browserErrors);
    }

    await waitForGatewayRpcQuiescence(network);
    await openFixtureSession(hotPage);
    await hotPage.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await hotPage.getByLabel("返回", { exact: true }).click();
    await hotPage.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    await waitForGatewayRpcQuiescence(network);

    for (let index = 0; index < sampleCount; index += 1) {
      await waitForGatewayRpcQuiescence(network);
      const sampleCapture = beginNavigationSampleCapture(network, observations, browserErrors, delayMs, "hot-runtime", index + 1);
      const closedDrawerThreadListBaseline = threadListRpcCount(network.rpcMethodCounts);
      network.currentStage = "hot-runtime-task-entry-to-drawer-open";
      await measureClick(hotPage, observations, {
        action: "composer-ready",
        cacheClass: "hot-runtime",
        delayMs,
        sourceSelector: `[data-testid="thread-${THREAD_ID}"]`,
        targetSelector: '[data-testid="message-input-root"]',
        targetVisible: true,
        additionalTargets: [
          { action: "task-shell-title-visible", targetSelector: '[data-testid="task-header-title"]', targetVisible: true },
          { action: "history-first-content-visible", targetSelector: '[data-testid="message-user"]', targetVisible: true },
        ],
        click: () => hotPage.getByTestId(`thread-${THREAD_ID}`).click(),
        wait: () => hotPage.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 }),
      }, context, network);
      network.currentStage = `${snapshotMode}:hot-runtime:task-interactive-closed-drawer`;
      await delay(100);
      network.drawerClosedListChecks.push({
        cacheClass: "hot-runtime",
        delayMs,
        requestsAfterTaskEntryBeforeDrawerOpen: Math.max(0, threadListRpcCount(network.rpcMethodCounts) - closedDrawerThreadListBaseline),
      });
      if (snapshotMode === "after") assert.equal(network.drawerClosedListChecks.at(-1).requestsAfterTaskEntryBeforeDrawerOpen, 0, "task entry with the drawer closed must not issue thread/list requests");
      await measureDrawerAndInput(hotPage, observations, delayMs, "hot-runtime", index, network, snapshotMode, context, navigationOnly);
      await measureClick(hotPage, observations, {
        action: "return-home",
        cacheClass: "hot-runtime",
        delayMs,
        sourceSelector: '[aria-label="返回"]',
        targetSelector: '[data-testid="new-workspace"]',
        targetVisible: true,
        click: () => hotPage.getByLabel("返回", { exact: true }).click(),
        wait: () => hotPage.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 }),
      }, context, network);
      await waitForGatewayRpcQuiescence(network);
      await collectPreShimNativeWebSocketEvidence(hotPage, network);
      await writeNavigationSampleCheckpoint(context, network, sampleCapture, observations, browserErrors);
    }

    await waitForGatewayRpcQuiescence(network);
    await hotPage.screenshot({ path: context.pathInArtifacts(`mobile-${delayMs}ms-final-home.png`), fullPage: true });
    await collectPreShimNativeWebSocketEvidence(hotPage, network);
    await closeOwnedMobilePage(hotPage);
  }

  const groupedMetrics = summarizeObservations(observations);
  await waitForGatewayRpcQuiescence(network);
  network.currentStage = "complete";
  const networkSnapshot = snapshotNetworkEvidence(network);
  const pendingAtSnapshot = pendingGatewayActivity(networkSnapshot);
  assert.equal(pendingAtSnapshot.total, 0, `network snapshot was taken with undrained response work: ${JSON.stringify(pendingAtSnapshot)}`);
  const coverageLedger = createCoverageLedger(delayValues, sampleCount, observations, networkSnapshot, gatewayCalls, snapshotMode);
  const gatewayRuntimeAfter = await inspectGatewayRuntimeSnapshot(gatewayRuntime.root, gatewayKcoderBinaryOverride);
  const launcherSourceDigestAfter = sha256(await readFile(new URL(import.meta.url)));
  const browserInfo = {
    version: await chromium.browser.version(),
    executablePath: basename(chromium.executablePath),
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    evidenceKind: "Chromium mobile viewport emulation; web-only evidence, not Android/iOS native profiling",
  };
  const provenance = {
    snapshotMode,
    scenarioMode: navigationOnly ? "navigation-only; send-local-pending left NOT_RUN" : "navigation-plus-isolated-mock-send",
    gitCommit: context.gitCommit,
    sourceSnapshotRoot: relative(repoRoot, sourceSnapshot.snapshotRoot),
    frozenSourceManifestSha256: sourceSnapshot.manifestSha256,
    freezeMetadataSha256: sourceSnapshot.freezeMetadataSha256,
    frozenSourceEntryCount: sourceSnapshot.entryCount,
    frozenSourceOverlaySha256: sourceSnapshot.overlaySha256,
    sourceComplementSha256: sourceSnapshot.complementSha256,
    sourceComplementStableDuringCopy: snapshotMode === "before"
      ? sourceSnapshot.complementSource?.sourceStableDuringCopy ?? beforeComplementHash === afterComplementHash
      : null,
    beforeComplementSource: sourceSnapshot.complementSource,
    launcherSourceSha256Before: launcherSourceDigestBefore,
    launcherSourceSha256After: launcherSourceDigestAfter,
    launcherSourceStableDuringRun: launcherSourceDigestBefore === launcherSourceDigestAfter,
    gatewayRuntimeSourceDigestBefore: gatewayRuntimeBefore.sourceDigest,
    gatewayRuntimeSourceDigestAfter: gatewayRuntimeAfter.sourceDigest,
    gatewayRuntimeSourceStableDuringRun: gatewayRuntimeBefore.sourceDigest === gatewayRuntimeAfter.sourceDigest,
    gatewayRuntimeSnapshot: {
      root: relative(repoRoot, gatewayRuntime.root),
      manifest: relative(repoRoot, gatewayRuntime.manifestPath),
      manifestSha256: gatewayRuntime.manifestSha256,
      binaryOverride: gatewayRuntime.binaryOverride,
      sourceTreeSha256: gatewayRuntimeBefore.sourceDigest,
      dependencyTreeSha256: gatewayRuntimeBefore.dependencyDigest,
      nodeExecutable: gatewayRuntimeBefore.nodeExecutable,
      nodeVersion: gatewayRuntimeBefore.nodeVersion,
      nodeExecutableStat: gatewayRuntimeBefore.runtimeInputs.nodeStat,
      kcoderBinaryPath: gatewayRuntimeBefore.kcoderBinaryPath,
      kcoderBinaryStat: gatewayRuntimeBefore.kcoderBinaryStat,
      kcoderBinarySha256: gatewayRuntimeBefore.kcoderBinarySha256,
      cwd: gatewayRuntime.root,
      scriptPath: resolve(gatewayRuntime.root, "dev-server.mjs"),
      storageRoot: relative(repoRoot, context.stateDir),
      runtimeStableDuringRun: gatewayRuntimeStable(gatewayRuntimeBefore, gatewayRuntimeAfter),
    },
    sourceTreeSha256: mobileWeb.sourceTreeSha256,
    bundleSha256: mobileWeb.bundleSha256,
    bundleManifest: relative(context.runRoot, mobileWeb.bundleManifestPath),
    dependencySourceTreeSha256: mobileWeb.dependencySourceTreeSha256,
    dependencyOwnedTreeSha256: mobileWeb.dependencyOwnedTreeSha256,
    sourceCompleteness: sourceSnapshot.completeness,
    excludedContentCounts: sourceSnapshot.excludedContentCounts,
    dependencySnapshot: dependencySnapshot ? {
      sourceRoot: dependencySnapshot.sourceRoot,
      privateRoot: dependencySnapshot.path,
      copyPid: dependencySnapshot.copyPid,
      copyStartedAtUtc: dependencySnapshot.copyStartedAtUtc,
      copyCompletedAtUtc: dependencySnapshot.copyCompletedAtUtc,
      excludedContentCounts: dependencySnapshot.excludedContentCounts,
      semantics: dependencySnapshot.semantics,
      exporterInputSha256: mobileWeb.dependencySourceTreeSha256,
      exporterOwnedCopySha256: mobileWeb.dependencyOwnedTreeSha256,
    } : {
      mode: "reused-verified-export",
      sourceRoot: mobileWeb.reusedManifestPath,
      privateRoot: null,
      copyPid: null,
      copyStartedAtUtc: null,
      copyCompletedAtUtc: null,
      excludedContentCounts: null,
      semantics: "reused artifact only after complete export manifest, source snapshot digest, bundle file list, per-file SHA-256 and aggregate bundle SHA-256 matched",
      exporterInputSha256: mobileWeb.dependencySourceTreeSha256,
      exporterOwnedCopySha256: mobileWeb.dependencyOwnedTreeSha256,
    },
    browser: browserInfo,
    gateway: { port: gateway.port, pid: gateway.child.pid, mock: true, isolatedWorkspace: true },
    noRealProviderRequests: true,
    mockTurnStartCount: gatewayCalls.turnStart,
    browserFrameTurnStartCount: network.browserFrameMethodCounts["turn/start"] ?? 0,
    modelRequestEvidence: "turn/start, when used for local pending measurement, terminates only in KCODER_STUDIO_MOCK; the isolated Gateway has no real Provider configured or invoked",
    complementChangeConfirmation: sourceSnapshot.complementSource
      ? "the before complement was copied from the explicit private snapshot; source-before, source-after, and copied complement SHA-256 values matched the supplied digest"
      : "writer confirmed Mobile package/app config/scripts, shared complement, and Gateway source were unchanged across the before freeze; their current copied SHA-256 digest is recorded",
    exportedWebArtifact: relative(context.runRoot, exportedWebArtifact),
  };
  await context.writeArtifactJson("phone-ux-browser-metrics.json", {
    schemaVersion: 1,
    delayDefinition: "extra one-way delay on Gateway HTTP responses and server-to-browser frames on established WebSocket; configured milliseconds are application response-path delay, not RTT",
    sampleCount,
    delayValues,
    navigationOnly,
    drawerCloseDiagnosticsEnabled,
    drawerCloseLatencyInterpretation: drawerCloseDiagnosticsEnabled ? "instrumented diagnostic timing; not an unbiased latency measurement" : "standard browser timing",
    observations,
    summaries: groupedMetrics,
    network: { ...summarizeNetwork(networkSnapshot), rpcFrameCorrelation: coverageLedger.rpcFrameCorrelation },
    actionTimelines: summarizeActionTimelines(observations, networkSnapshot),
    browserErrors,
    browser: browserInfo,
  });
  await context.writeArtifactJson("phone-ux-coverage-ledger.json", coverageLedger);
  await context.writeArtifactJson("phone-ux-provenance.json", provenance);

  const expectedMockTurnStarts = observations.filter(sample => sample.action === "send-local-pending").length;
  assert.equal(networkSnapshot.browserFrameMethodCounts["turn/start"] ?? 0, expectedMockTurnStarts, "only the expected isolated local pending samples may send turn/start from the browser");
  assert.equal(gatewayRuntimeAfter.sourceDigest, gatewayRuntimeBefore.sourceDigest, "frozen Gateway runtime source changed during the browser measurement");
  assert.equal(gatewayRuntimeAfter.dependencyDigest, gatewayRuntimeBefore.dependencyDigest, "frozen Gateway dependency tree changed during the browser measurement");
  assert.equal(gatewayRuntimeStable(gatewayRuntimeBefore, gatewayRuntimeAfter), true, "Gateway runtime executable inputs changed during the browser measurement");
  assert.equal(launcherSourceDigestAfter, launcherSourceDigestBefore, "test-owned Gateway launcher changed during the browser measurement");
  assert.ok(networkSnapshot.httpResponsePathDelays.length > 0, "HTTP response-path injection must observe at least one Gateway API response");
  assert.ok(networkSnapshot.websocketResponsePathDelays.length > 0, "WebSocket response-path injection must observe at least one Gateway frame");
  assert.equal(networkSnapshot.websocketForwardErrors, 0, "WebSocket response frames must be forwarded without route errors");
  for (const delayMs of delayValues) {
    assert.ok(networkSnapshot.httpResponsePathDelays.some(sample => sample.configuredDelayMs === delayMs), `HTTP injection missing configured ${delayMs}ms response delay`);
    assert.ok(networkSnapshot.websocketResponsePathDelays.some(sample => sample.configuredDelayMs === delayMs), `WebSocket injection missing configured ${delayMs}ms response delay`);
  }
  assert.equal(browserErrors.length, 0, "the measured Mobile Web flows must not produce page errors");
  assert.equal(networkSnapshot.applicationWebSocketCaptureHealth.some(row => row.socketOverflowCount > 0 || row.frameOverflowCount > 0 || row.storageWriteFailureCount > 0), false, "application WebSocket frame instrumentation must not truncate evidence or fail to persist it");
  const coreFailures = observations.filter(sample => ["composer-ready", "task-shell-title-visible", "history-first-content-visible", "return-home", "refresh-home", "drawer-open", "drawer-close", "input-feedback", "send-local-pending", "mock-gateway-turn-start-ack"].includes(sample.action) && !sample.ok);
  assert.equal(coreFailures.length, 0, "all measured core UI actions must complete");

  return {
    status: coverageLedger.overallStatus,
    sampleCount,
    delayValues,
    summaries: groupedMetrics,
    httpSamples: networkSnapshot.http.length,
    websocketFrames: networkSnapshot.websocketFrames,
    gatewayCalls,
    browser: browserInfo,
    coverageLedger: "phone-ux-coverage-ledger.json",
    provenance: "phone-ux-provenance.json",
  };
});

async function resolvePrivateBeforeComplementRoot(requestedDirectory) {
  const canonicalRepoRoot = await realpath(repoRoot);
  const privateInputRoot = resolve(canonicalRepoRoot, "target/private-phone-ux-implementation");
  const requestedRoot = resolve(canonicalRepoRoot, requestedDirectory);
  assert.ok(requestedRoot.startsWith(privateInputRoot + sep), "--before-complement-dir must be below target/private-phone-ux-implementation");
  const canonicalPrivateInputRoot = await realpath(privateInputRoot);
  const canonicalRequestedRoot = await realpath(requestedRoot);
  assert.ok(canonicalRequestedRoot.startsWith(canonicalPrivateInputRoot + sep), "--before-complement-dir canonical path escapes target/private-phone-ux-implementation");
  assert.equal(canonicalRequestedRoot, requestedRoot, "--before-complement-dir must not traverse symlinked paths");
  const requestedInfo = await lstat(requestedRoot);
  assert.ok(requestedInfo.isDirectory() && !requestedInfo.isSymbolicLink(), "--before-complement-dir must be an existing regular directory");
  return canonicalRequestedRoot;
}

async function prepareSnapshot(context, mode, currentMobileRoot, currentSharedRoot, snapshotDirectory, expectedSourceDigest, beforeComplementDirectory, beforeComplementSha256) {
  const snapshotRoot = resolve(repoRoot, snapshotDirectory || `target/private-phone-latency-implementation/${mode}`);
  assert.ok(snapshotRoot.startsWith(`${repoRoot}${sep}`), "frozen source directory must remain inside the repository target tree");
  const manifestPath = resolve(snapshotRoot, "sha256.json");
  await access(manifestPath);
  const manifestBytes = await readFile(manifestPath);
  const hashes = JSON.parse(manifestBytes.toString("utf8"));
  assert.ok(hashes && typeof hashes === "object" && !Array.isArray(hashes), "frozen source manifest must map repository-relative paths to SHA-256 values");
  const entries = Object.entries(hashes);
  assert.ok(entries.length > 0, "frozen source manifest is empty");
  for (const [path, hash] of entries) {
    const validBeforePath = path.startsWith("apps/kcoder-studio/mobile/") || path.startsWith("apps/kcoder-studio/shared/");
    const validAfterPath = path.startsWith("apps/kcoder-studio/") || path.startsWith("apps/kcoder-relay/");
    assert.ok(mode === "before" ? validBeforePath : validAfterPath, `unexpected frozen-source path: ${path}`);
    const pathSegments = path.split("/");
    assert.equal(pathSegments.includes("node_modules"), false, `frozen source must not include dependencies: ${path}`);
    assert.equal(pathSegments.some(segment => segment.startsWith(".env")), false, `frozen source must not include dotenv credentials: ${path}`);
    const isDependencyLockfile = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path);
    const isPinnedStaticMobilePackageLock = mode === "after"
      && Boolean(reuseExportDirectory)
      && Boolean(reuseExportManifest)
      && path === "apps/kcoder-studio/mobile/package-lock.json"
      && hash === "848076f520f165128b601b27d96d4d32cf25e8929ee54b672f198b9a4c224e26";
    assert.ok(!isDependencyLockfile || isPinnedStaticMobilePackageLock, `frozen source may only retain the exact pinned Mobile package-lock as static metadata for after-mode reuse-export: ${path}`);
    assert.match(hash, /^[a-f0-9]{64}$/, `invalid frozen-source digest for ${path}`);
  }
  let freezeMetadataSha256 = null;
  let frozenSourceDigest = null;
  if (mode === "after") {
    const freezePath = resolve(snapshotRoot, "freeze.json");
    const metadataPath = resolve(snapshotRoot, "metadata.json");
    const freezeBytes = await readFile(freezePath).catch(async error => {
      if (error?.code !== "ENOENT") throw error;
      return readFile(metadataPath);
    });
    const freezeMetadata = JSON.parse(freezeBytes.toString("utf8"));
    freezeMetadataSha256 = sha256(freezeBytes);
    frozenSourceDigest = freezeMetadata.sourceDigest ?? freezeMetadata.manifestDigest ?? null;
    assert.match(String(frozenSourceDigest), /^[a-f0-9]{64}$/, "after freeze metadata must contain a source digest");
    if (freezeMetadata.manifestDigest) {
      assert.equal(freezeMetadata.manifestDigest, sha256(manifestBytes), "after freeze metadata does not match sha256.json");
    }
    if (expectedSourceDigest) assert.equal(frozenSourceDigest, expectedSourceDigest, "after freeze source digest does not match the explicitly pinned candidate");
    const expectedFileCount = freezeMetadata.sourceFiles ?? freezeMetadata.count ?? freezeMetadata.files;
    assert.equal(entries.length, Number(expectedFileCount), "after source file count does not match freeze metadata");
  }

  const sourceRoot = context.pathInState(`mobile-source-${mode}`);
  const mobileRoot = resolve(sourceRoot, "apps/kcoder-studio/mobile");
  const sharedRoot = resolve(sourceRoot, "apps/kcoder-studio/shared");
  await mkdir(mobileRoot, { recursive: true, mode: 0o700 });
  await mkdir(sharedRoot, { recursive: true, mode: 0o700 });
  context.registerTemporaryDirectory(`sanitized Mobile/shared source for ${mode}`, sourceRoot);
  const excludedContent = Object.create(null);
  let complementSource = null;
  let complementShaBeforeOverlay = null;
  if (mode === "before") {
    if (beforeComplementDirectory) {
      const pinnedComplementRoot = await resolvePrivateBeforeComplementRoot(beforeComplementDirectory);
      const pinnedMobileRoot = resolve(pinnedComplementRoot, "apps/kcoder-studio/mobile");
      const pinnedSharedRoot = resolve(pinnedComplementRoot, "apps/kcoder-studio/shared");
      for (const pinnedRoot of [pinnedMobileRoot, pinnedSharedRoot]) {
        const pinnedInfo = await lstat(pinnedRoot);
        assert.ok(pinnedInfo.isDirectory() && !pinnedInfo.isSymbolicLink(), "private before-complement Mobile/shared roots must be regular directories");
      }
      const sourceSha256BeforeCopy = await hashComplement(pinnedMobileRoot, pinnedSharedRoot);
      assert.equal(sourceSha256BeforeCopy, beforeComplementSha256, "private before-complement source does not match --before-complement-sha256");
      await copySanitizedTree(pinnedMobileRoot, mobileRoot, excludedContent);
      await copySanitizedTree(pinnedSharedRoot, sharedRoot, excludedContent);
      const sourceSha256AfterCopy = await hashComplement(pinnedMobileRoot, pinnedSharedRoot);
      assert.equal(sourceSha256AfterCopy, sourceSha256BeforeCopy, "private before-complement source changed while it was being copied");
      complementShaBeforeOverlay = await hashComplement(mobileRoot, sharedRoot);
      assert.equal(complementShaBeforeOverlay, beforeComplementSha256, "copied private before-complement does not match the supplied SHA-256");
      complementSource = {
        directory: relative(repoRoot, pinnedComplementRoot),
        expectedSha256: beforeComplementSha256,
        sourceSha256BeforeCopy,
        sourceSha256AfterCopy,
        copiedSha256: complementShaBeforeOverlay,
        sourceStableDuringCopy: sourceSha256BeforeCopy === sourceSha256AfterCopy,
      };
    } else {
      await copySanitizedTree(currentMobileRoot, mobileRoot, excludedContent);
      await copySanitizedTree(currentSharedRoot, sharedRoot, excludedContent);
      complementShaBeforeOverlay = await hashComplement(mobileRoot, sharedRoot);
    }
  }

  const expectedMobileSrc = new Set(entries
    .map(([path]) => path.startsWith("apps/kcoder-studio/mobile/src/") ? path.slice("apps/kcoder-studio/mobile/src/".length) : null)
    .filter(Boolean));
  const currentMobileSrc = resolve(mobileRoot, "src");
  const currentSrcFiles = mode === "before" ? await listFiles(currentMobileSrc) : [];
  if (mode === "before") {
    // The before SHA list freezes the complete Mobile/src tree. Remove any
    // source added after that freeze before restoring the frozen file bytes.
    for (const path of currentSrcFiles) {
      if (!expectedMobileSrc.has(path)) await rm(resolve(currentMobileSrc, path), { force: true });
    }
    await pruneEmptyDirectories(currentMobileSrc);
  }
  let overlay = [];
  for (const [path, expectedHash] of entries) {
    const source = resolve(snapshotRoot, path);
    const destination = resolve(sourceRoot, path);
    assert.ok(destination.startsWith(`${sourceRoot}${sep}`), "frozen source path escaped the private E2E state directory");
    const sourceBytes = await readFile(source);
    const actualHash = sha256(sourceBytes);
    assert.equal(actualHash, expectedHash, `frozen before/after source hash mismatch for ${path}`);
    await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    overlay.push({ path, sha256: actualHash });
  }
  const complementShaAfterOverlay = mode === "before" ? await hashComplement(mobileRoot, sharedRoot) : null;
  if (mode === "before") assert.equal(complementShaAfterOverlay, complementShaBeforeOverlay, "the frozen overlay unexpectedly changed a complement file");
  if (beforeComplementSha256) assert.equal(complementShaAfterOverlay, beforeComplementSha256, "before complement SHA-256 changed during the frozen 224-file overlay");
  const completeness = {
    mobileSrcExpected: expectedMobileSrc.size,
    mobileSrcRestored: overlay.filter(item => item.path.startsWith("apps/kcoder-studio/mobile/src/")).length,
    mobileSrcFilesRemovedSinceFreezeCount: currentSrcFiles.filter(path => !expectedMobileSrc.has(path)).length,
    manifestFileCount: entries.length,
    workspaceComplementCopied: mode === "before" && !beforeComplementDirectory,
    privateBeforeComplementCopied: Boolean(complementSource),
    complementSource: mode === "before"
      ? complementSource
        ? `copied from verified private source ${complementSource.directory}; source-before, source-after, and copied hashes matched ${complementSource.expectedSha256}`
        : "copied from the current workspace and identified by SHA-256; writer confirmed build-affecting complement files were unchanged"
      : `no active-workspace complement copied; the exact ${entries.length}-file after freeze is copied and hash-verified. The one pinned Mobile package-lock remains static source metadata and is never executed or used to install dependencies on this reuse-only path; the Mobile/shared roots and 37-file bundle are checked against the reused export, with dependency trees separately pinned by its provenance.`,
  };
  assert.equal(completeness.mobileSrcExpected, completeness.mobileSrcRestored, "the frozen manifest does not cover every Mobile/src file");
  if (mode === "after") assert.equal(overlay.length, entries.length, "after source snapshot must contain exactly every frozen file");
  return {
    mobileRoot,
    sharedRoot,
    snapshotRoot,
    manifestSha256: sha256(manifestBytes),
    freezeMetadataSha256,
    frozenSourceDigest,
    entryCount: entries.length,
    overlaySha256: sha256(Buffer.from(JSON.stringify(overlay))),
    complementSha256: complementShaAfterOverlay,
    complementSource,
    completeness,
    excludedContentCounts: excludedContent,
  };
}

async function reuseMobileWebExport(context, sourceSnapshot, bundleDirectory, manifestArgument) {
  let bundleRoot = resolve(repoRoot, bundleDirectory);
  const runArtifactsRoot = resolve(repoRoot, "target/test");
  const privateInputRoot = resolve(repoRoot, "target/private-phone-ux-implementation");
  let manifestPath = resolve(repoRoot, manifestArgument || resolve(bundleRoot, "..", `mobile-web-export-mobile-high-latency-${snapshotMode}-manifest.json`));
  const bundleIsRunArtifact = bundleRoot.startsWith(`${runArtifactsRoot}${sep}`);
  const manifestIsRunArtifact = manifestPath.startsWith(`${runArtifactsRoot}${sep}`);
  const bundleIsPrivateInput = bundleRoot.startsWith(`${privateInputRoot}${sep}`);
  const manifestIsPrivateInput = manifestPath.startsWith(`${privateInputRoot}${sep}`);
  if (bundleIsRunArtifact && manifestIsRunArtifact) {
    // Existing target/test artifacts remain supported for one-off inspection.
  } else {
    assert.ok(bundleIsPrivateInput && manifestIsPrivateInput, "reused Mobile Web bundle and manifest must both come from target/test or explicitly selected target/private-phone-ux-implementation inputs");
    bundleRoot = await resolveExistingPrivatePath(repoRoot, bundleRoot);
    manifestPath = await resolveExistingPrivatePath(repoRoot, manifestPath);
    const bundleInfo = await lstat(bundleRoot);
    const manifestInfo = await lstat(manifestPath);
    assert.ok(bundleInfo.isDirectory() && !bundleInfo.isSymbolicLink(), "private Mobile Web bundle must be an existing regular directory");
    assert.ok(manifestInfo.isFile() && !manifestInfo.isSymbolicLink(), "private Mobile Web export manifest must be an existing regular file");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.status, "complete", "reused Mobile Web export manifest must be complete");
  assert.equal(manifest.failurePhase, null, "reused Mobile Web export must not have a failure phase");
  assert.equal(manifest.sourceUnchanged, true, "reused Mobile Web source must have stayed stable during its original export");
  assert.equal(manifest.snapshotUnchangedDuringExport, true, "reused Mobile Web build snapshot must have stayed stable during its original export");
  assert.equal(manifest.dependencyProvenance?.sourceUnchanged, true, "reused Mobile Web dependencies must have stayed stable during its original export");

  const expectedSourceRoots = [
    { name: "mobile", path: sourceSnapshot.mobileRoot, destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: sourceSnapshot.sharedRoot, destination: "apps/kcoder-studio/shared" },
  ];
  const sourceTree = await hashMobileExportSourceRoots(expectedSourceRoots);
  assert.equal(manifest.sourceTreeSha256, sourceTree.sha256, "reused Mobile Web bundle source digest does not match the selected frozen source snapshot");
  assert.deepEqual(
    manifest.inputRootsAfter?.map(({ name, destination, sha256, fileCount }) => ({ name, destination, sha256, fileCount })),
    sourceTree.roots.map(({ name, destination, sha256, fileCount }) => ({ name, destination, sha256, fileCount })),
    "reused Mobile Web bundle source roots do not match the selected snapshot",
  );

  const actualBundleFiles = await hashBundleTree(bundleRoot);
  assert.deepEqual(actualBundleFiles, manifest.bundleFiles, "reused Mobile Web bundle file list or per-file SHA-256 differs from the complete export manifest");
  assert.equal(sha256(Buffer.from(JSON.stringify(actualBundleFiles))), manifest.bundleSha256, "reused Mobile Web bundle aggregate SHA-256 differs from its manifest");
  assert.ok(actualBundleFiles.some(file => file.path === "index.html" && file.sha256 === manifest.indexHtmlSha256), "reused Mobile Web bundle index.html digest does not match its manifest");

  return {
    path: bundleRoot,
    sourceTreeSha256: manifest.sourceTreeSha256,
    bundleSha256: manifest.bundleSha256,
    bundleManifestPath: manifestPath,
    reusedManifestPath: manifestPath,
    dependencySourceTreeSha256: manifest.dependencyProvenance?.sourceTreeSha256Before ?? null,
    dependencyOwnedTreeSha256: manifest.dependencyProvenance?.copiedTreeSha256 ?? null,
    reuseValidation: {
      manifestStatus: manifest.status,
      sourceTreeMatchesSelectedSnapshot: true,
      sourceRootCount: sourceTree.roots.length,
      bundleFilesMatchManifest: true,
      bundleFileCount: actualBundleFiles.length,
      bundleSha256: manifest.bundleSha256,
    },
  };
}

async function hashMobileExportSourceRoots(roots) {
  const hashedRoots = [];
  for (const root of roots) {
    const files = [];
    await appendExportSourceFiles(root.path, "", files);
    files.sort((left, right) => left.path.localeCompare(right.path));
    hashedRoots.push({ name: root.name, destination: root.destination, sha256: sha256(Buffer.from(JSON.stringify(files))), fileCount: files.length });
  }
  return {
    roots: hashedRoots,
    sha256: sha256(Buffer.from(JSON.stringify(hashedRoots.map(({ name, destination, sha256: digest }) => ({ name, destination, sha256: digest }))))),
  };
}

async function appendExportSourceFiles(root, relativeRoot, output) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (exportSourceExcluded(entry.name, entry.isDirectory())) continue;
    const absolute = resolve(root, entry.name);
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const info = await lstat(absolute);
    assert.ok(!info.isSymbolicLink(), `reused export source contains a symlink: ${relativePath}`);
    if (info.isDirectory()) await appendExportSourceFiles(absolute, relativePath, output);
    else if (info.isFile()) {
      const contents = await readFile(absolute);
      output.push({ path: relativePath, size: contents.length, sha256: sha256(contents) });
    }
  }
}

function exportSourceExcluded(name, isDirectory) {
  if (isDirectory && [".expo", ".git", "dist", "node_modules"].includes(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  return /(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name);
}

async function hashBundleTree(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      const info = await lstat(absolute);
      assert.ok(!info.isSymbolicLink(), `reused Mobile Web bundle contains a symlink: ${path}`);
      if (info.isDirectory()) await visit(absolute);
      else if (info.isFile()) {
        const contents = await readFile(absolute);
        files.push({ path, size: contents.length, sha256: sha256(contents) });
      } else {
        assert.fail(`reused Mobile Web bundle contains a non-regular file: ${path}`);
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function prepareGatewayRuntimeSnapshot(context, snapshotDirectoryArgument, binaryOverride, expectedBinarySha256) {
  let snapshotRoot = snapshotDirectoryArgument
    ? resolve(repoRoot, snapshotDirectoryArgument)
    : context.pathInArtifacts("gateway-runtime-frozen");
  const targetTestRoot = resolve(repoRoot, "target/test");
  const privateSnapshotRoot = resolve(repoRoot, "target/private-phone-ux-implementation");
  const isTestArtifactSnapshot = snapshotRoot.startsWith(`${targetTestRoot}${sep}`);
  const isExplicitPrivateSnapshot = Boolean(snapshotDirectoryArgument)
    && snapshotRoot.startsWith(`${privateSnapshotRoot}${sep}`);
  assert.ok(
    isTestArtifactSnapshot || isExplicitPrivateSnapshot,
    "frozen Gateway runtime must be inside target/test or an explicitly selected target/private-phone-ux-implementation snapshot",
  );
  if (isExplicitPrivateSnapshot) {
    const validated = await resolveExistingPrivateGatewaySnapshot(repoRoot, snapshotDirectoryArgument);
    snapshotRoot = validated.snapshotRoot;
  }
  const manifestPath = resolve(snapshotRoot, "gateway-runtime-freeze.json");
  try {
    await access(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.status, "complete", "reused Gateway runtime freeze must be complete");
      const inspected = await inspectGatewayRuntimeSnapshot(snapshotRoot, binaryOverride);
      assert.equal(inspected.sourceDigest, manifest.sourceTreeSha256, "frozen Gateway source tree no longer matches its manifest");
      assert.equal(inspected.dependencyDigest, manifest.dependencyTreeSha256, "frozen Gateway dependency tree no longer matches its manifest");
      assert.equal(inspected.nodeExecutable, manifest.nodeExecutable, "frozen Gateway Node executable path differs from its manifest");
      assert.equal(inspected.nodeVersion, manifest.nodeVersion, "frozen Gateway Node version differs from its manifest");
      if (binaryOverride) {
        assert.deepEqual(
          { nodeExecutable: inspected.runtimeInputs.nodeExecutable, nodeVersion: inspected.runtimeInputs.nodeVersion, nodeStat: inspected.runtimeInputs.nodeStat },
          { nodeExecutable: manifest.runtimeInputs.nodeExecutable, nodeVersion: manifest.runtimeInputs.nodeVersion, nodeStat: manifest.runtimeInputs.nodeStat },
          "frozen Gateway Node executable inputs differ from the freeze manifest",
        );
        assert.equal(inspected.kcoderBinarySha256, expectedBinarySha256, "explicit Gateway KCoder binary does not match its declared SHA-256");
      } else {
        assert.deepEqual(inspected.runtimeInputs, manifest.runtimeInputs, "frozen Gateway runtime executable inputs differ from the freeze manifest");
      }
    return {
      root: snapshotRoot,
      manifestPath,
      manifestSha256: sha256(await readFile(manifestPath)),
      manifest,
      binaryPath: inspected.kcoderBinaryPath,
      binaryOverride: binaryOverride ? { path: inspected.kcoderBinaryPath, sha256: inspected.kcoderBinarySha256 } : null,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    assert.ok(!isExplicitPrivateSnapshot, "an explicitly selected private Gateway runtime must already contain its complete freeze manifest");
  }

  await mkdir(snapshotRoot, { recursive: false, mode: 0o700 });
  const appNodeModules = resolve(appRoot, "node_modules");
  const appNodeModulesReal = await realpath(appNodeModules);
  await assertNoEscapingLinks(appNodeModules, appNodeModulesReal);
  const originBefore = await hashGatewayRuntimeInputs(appRoot);
  const sourceEntries = [];
  for (const name of ["dev-server.mjs", "package.json", "pnpm-lock.yaml"]) {
    const source = resolve(appRoot, name);
    try {
      const info = await lstat(source);
      if (info.isFile()) {
        sourceEntries.push({ source, destination: resolve(snapshotRoot, name) });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const name of ["src", "shared"]) {
    sourceEntries.push({ source: resolve(appRoot, name), destination: resolve(snapshotRoot, name), directory: true });
  }
  for (const entry of sourceEntries) {
    if (entry.directory) {
      await cp(entry.source, entry.destination, { recursive: true, dereference: true, filter: sourceSnapshotFilter });
    } else {
      await cp(entry.source, entry.destination, { dereference: true, filter: sourceSnapshotFilter });
    }
  }
  await cp(appNodeModules, resolve(snapshotRoot, "node_modules"), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: dependencySnapshotFilter,
  });
  const copiedNodeModules = resolve(snapshotRoot, "node_modules");
  await assertNoEscapingLinks(copiedNodeModules, await realpath(copiedNodeModules));

  const inputs = await inspectGatewayRuntimeSnapshot(snapshotRoot);
  const originAfter = await hashGatewayRuntimeInputs(appRoot);
  assert.deepEqual(originAfter, originBefore, "Gateway source or dependencies changed while creating the immutable runtime snapshot");
  assert.equal(inputs.sourceDigest, originBefore.sourceDigest, "copied Gateway source files differ from the stable workspace source");
  assert.equal(inputs.dependencyDigest, originBefore.dependencyDigest, "copied Gateway dependencies differ from the stable workspace dependencies");
  const runtimeInputs = await readGatewayExecutableInputs(binaryOverride);
  if (binaryOverride) assert.equal(runtimeInputs.kcoderBinarySha256, expectedBinarySha256, "explicit Gateway KCoder binary does not match its declared SHA-256");
  const manifest = {
    schemaVersion: 1,
    status: "complete",
    createdAtUtc: new Date().toISOString(),
    sourceRoot: relative(repoRoot, appRoot),
    sourceFiles: inputs.sourceFiles,
    sourceTreeSha256: inputs.sourceDigest,
    workspaceSourceTreeSha256: originBefore.sourceDigest,
    dependencyFiles: inputs.dependencyFiles,
    dependencyTreeSha256: inputs.dependencyDigest,
    workspaceDependencyTreeSha256: originBefore.dependencyDigest,
    dependencySourceRoot: relative(repoRoot, appNodeModulesReal),
    dependencyCopySemantics: "one-time private copy preserving package-manager symlinks with verbatim targets; every dependency symlink is checked to resolve inside the owned node_modules tree; .env/key/credential/cache files are excluded while dependency packages such as dotenv remain",
    runtimeInputs,
    nodeExecutable: inputs.nodeExecutable,
    nodeVersion: inputs.nodeVersion,
    kcoderBinaryPath: inputs.kcoderBinaryPath,
    kcoderBinaryStat: inputs.kcoderBinaryStat,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, bytes, { flag: "wx", mode: 0o600 });
  return {
    root: snapshotRoot,
    manifestPath,
    manifestSha256: sha256(bytes),
    manifest,
    binaryPath: runtimeInputs.kcoderBinaryPath,
    binaryOverride: binaryOverride ? { path: runtimeInputs.kcoderBinaryPath, sha256: runtimeInputs.kcoderBinarySha256 } : null,
  };
}

async function inspectGatewayRuntimeSnapshot(snapshotRoot, binaryOverride = null) {
  const sourceFiles = [];
  const dependencyFiles = [];
  await appendGatewaySnapshotFiles(snapshotRoot, "", sourceFiles, false);
  await appendGatewaySnapshotFiles(resolve(snapshotRoot, "node_modules"), "", dependencyFiles, true);
  sourceFiles.sort((left, right) => left.path.localeCompare(right.path));
  dependencyFiles.sort((left, right) => left.path.localeCompare(right.path));
  const nodeExecutable = await realpath(process.execPath);
  const nodeVersion = process.version;
  const kcoderBinaryPath = binaryOverride || process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
  const kcoderBinaryStat = await regularFileIdentity(kcoderBinaryPath);
  const runtimeInputs = await readGatewayExecutableInputs(binaryOverride);
  return {
    sourceFiles,
    sourceDigest: sha256(Buffer.from(JSON.stringify(sourceFiles))),
    dependencyFiles,
    dependencyDigest: sha256(Buffer.from(JSON.stringify(dependencyFiles))),
    nodeExecutable,
    nodeVersion,
    kcoderBinaryPath: kcoderBinaryStat ? await realpath(kcoderBinaryPath) : resolve(kcoderBinaryPath),
    kcoderBinaryStat,
    kcoderBinarySha256: runtimeInputs.kcoderBinarySha256,
    runtimeInputs,
  };
}

async function hashGatewayRuntimeInputs(root) {
  const sourceFiles = [];
  for (const name of ["dev-server.mjs", "package.json", "pnpm-lock.yaml"]) {
    const path = resolve(root, name);
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      sourceFiles.push({ path: name, size: info.size, sha256: sha256(await readFile(path)) });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const name of ["src", "shared"]) await appendGatewaySnapshotFiles(resolve(root, name), name, sourceFiles, false);
  const dependencyFiles = [];
  await appendGatewaySnapshotFiles(resolve(root, "node_modules"), "", dependencyFiles, true);
  sourceFiles.sort((left, right) => left.path.localeCompare(right.path));
  dependencyFiles.sort((left, right) => left.path.localeCompare(right.path));
  return {
    sourceFiles,
    sourceDigest: sha256(Buffer.from(JSON.stringify(sourceFiles))),
    dependencyFiles,
    dependencyDigest: sha256(Buffer.from(JSON.stringify(dependencyFiles))),
  };
}

async function appendGatewaySnapshotFiles(root, relativeRoot, output, dependencies) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "gateway-runtime-freeze.json") continue;
    if (!dependencies && entry.name === "node_modules") continue;
    if (dependencies && dependencySnapshotExcluded(entry.name, entry.isDirectory())) continue;
    if (!dependencies && sourceSnapshotExcluded(entry.name, entry.isDirectory())) continue;
    const absolute = resolve(root, entry.name);
    const path = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    let info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      assert.ok(dependencies, `frozen Gateway source snapshot contains a symlink: ${path}`);
      output.push({ path, symlinkTarget: await readlink(absolute) });
      info = await stat(absolute);
    }
    if (info.isDirectory()) await appendGatewaySnapshotFiles(absolute, path, output, dependencies);
    else if (info.isFile()) {
      const contents = await readFile(absolute);
      output.push({ path, size: contents.length, sha256: sha256(contents) });
    }
  }
}

function sourceSnapshotFilter(sourcePath) {
  const name = basename(sourcePath);
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return false;
  return !/\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

function dependencySnapshotFilter(sourcePath) {
  const name = basename(sourcePath);
  return !dependencySnapshotExcluded(name, false) && !dependencySnapshotExcluded(name, true);
}

function dependencySnapshotExcluded(name, isDirectory) {
  if (isDirectory && [".vite", ".cache", "coverage", ".git"].includes(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  if ([".npmrc", "credentials.json", "account_credentials.json"].includes(name)) return true;
  if (/(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name)) return true;
  return /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

function sourceSnapshotExcluded(name, isDirectory) {
  if (isDirectory && [".git", ".expo", "dist", "target"].includes(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  return /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

async function assertNoEscapingLinks(root, allowedRoot) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      assert.ok(target === allowedRoot || target.startsWith(`${allowedRoot}${sep}`), `Gateway dependency symlink escapes its package root: ${relative(root, path)}`);
    } else if (info.isDirectory()) {
      await assertNoEscapingLinks(path, allowedRoot);
    }
  }
}

async function readGatewayExecutableInputs(binaryOverride = null) {
  const nodeExecutable = await realpath(process.execPath);
  const nodeStat = await regularFileIdentity(nodeExecutable);
  const kcoderBinaryPath = binaryOverride || process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
  const kcoderBinaryStat = await regularFileIdentity(kcoderBinaryPath);
  return {
    nodeExecutable,
    nodeVersion: process.version,
    nodeStat,
    kcoderBinaryPath: kcoderBinaryStat ? await realpath(kcoderBinaryPath) : resolve(kcoderBinaryPath),
    kcoderBinaryStat,
    kcoderBinarySha256: kcoderBinaryStat ? sha256(await readFile(kcoderBinaryPath)) : null,
  };
}

async function regularFileIdentity(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return { size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function gatewayRuntimeStable(before, after) {
  return before.sourceDigest === after.sourceDigest
    && before.dependencyDigest === after.dependencyDigest
    && before.nodeExecutable === after.nodeExecutable
    && before.nodeVersion === after.nodeVersion
    && before.kcoderBinaryPath === after.kcoderBinaryPath
    && JSON.stringify(before.kcoderBinaryStat) === JSON.stringify(after.kcoderBinaryStat)
    && JSON.stringify(before.runtimeInputs) === JSON.stringify(after.runtimeInputs);
}

async function startFrozenGateway(context, gatewayRuntime, { label, workspace, serversFile, serversStore, webRoot, mock }) {
  const host = "127.0.0.1";
  const port = 0;
  const authToken = randomBytes(24).toString("base64url");
  context.registerSecret(authToken);
  const overrides = {
    KCODER_STUDIO_HOST: host,
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_KCODER_BIN: gatewayRuntime.binaryPath || gatewayRuntime.manifest.runtimeInputs.kcoderBinaryPath,
    KCODER_STUDIO_WORKSPACE: workspace,
    KCODER_STUDIO_WEB_ROOT: webRoot,
    KCODER_STUDIO_SERVERS_FILE: serversFile,
    KCODER_STUDIO_SERVERS_STORE: serversStore,
    KCODER_STUDIO_AUTH_TOKEN: authToken,
    KCODER_STUDIO_ALLOWED_HOSTS: "127.0.0.1,localhost,::1",
    KCODER_STUDIO_MOCK: mock ? "1" : "0",
  };
  const env = context.isolatedEnvironment(overrides);
  const scriptPath = resolve(gatewayRuntime.root, "dev-server.mjs");
  const child = context.spawnOwned(label, process.execPath, [scriptPath], {
    cwd: gatewayRuntime.root,
    env,
  });
  const logPath = resolve(context.logsDir, `${label}.log`);
  const gatewayPort = await waitFor(async () => {
    const log = await readFile(logPath, "utf8").catch(() => "");
    const match = log.match(/KCoder Studio: http:\/\/[^:]+:(\d+)/);
    if (child.exitCode !== null) throw new Error(`frozen Gateway exited with code ${child.exitCode}; inspect ${logPath}`);
    return match ? Number(match[1]) : null;
  }, 15_000, "frozen isolated Gateway startup", 50, context.abortSignal);
  context.registerPort(label, gatewayPort);
  return {
    child,
    port: gatewayPort,
    host,
    serversStore,
    baseUrl: `http://${host}:${gatewayPort}`,
    wsUrl: `ws://${host}:${gatewayPort}`,
    authToken,
    logPath,
    scriptPath,
    cwd: gatewayRuntime.root,
  };
}

async function copySanitizedTree(sourceRoot, destinationRoot, excludedContent) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const source = resolve(sourceRoot, entry.name);
    const destination = resolve(destinationRoot, entry.name);
    const category = excludedCategory(entry.name, entry.isDirectory());
    if (category) {
      excludedContent[category] = (excludedContent[category] ?? 0) + 1;
      continue;
    }
    const info = await lstat(source);
    assert.ok(!info.isSymbolicLink(), `source tree contains a symlink: ${relative(sourceRoot, source)}`);
    if (info.isDirectory()) {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await copySanitizedTree(source, destination, excludedContent);
    } else if (info.isFile()) {
      await copyFile(source, destination);
    }
  }
}

async function createDependencySnapshot(context, currentMobileRoot) {
  const sourceRoot = resolve(currentMobileRoot, "node_modules");
  const snapshotRoot = context.pathInState("mobile-dependency-input-frozen");
  await mkdir(snapshotRoot, { recursive: false, mode: 0o700 });
  context.registerTemporaryDirectory("isolated Mobile dependency input snapshot", snapshotRoot);
  const label = "phone-ux-dependency-snapshot-copy";
  const copyStartedAtUtc = new Date().toISOString();
  const child = context.spawnOwned(label, "cp", ["-aL", "--reflink=auto", `${sourceRoot}/.`, `${snapshotRoot}/`], {
    cwd: repoRoot,
    env: context.isolatedEnvironment(),
  });
  let spawnError = null;
  child.once("error", error => { spawnError = error; });
  try {
    await waitFor(
      () => spawnError || child.exitCode !== null || child.signalCode !== null,
      10 * 60_000,
      "isolated Mobile dependency input snapshot copy",
      100,
      context.abortSignal,
    );
    if (spawnError) throw new Error(`dependency snapshot copy could not start: ${spawnError.message}`);
    assert.equal(child.exitCode, 0, `dependency snapshot copy exited with ${child.signalCode || `code ${child.exitCode}`}`);
  } finally {
    await context.stopOwned(label);
  }
  const excludedContentCounts = Object.create(null);
  await removeDependencyCacheAndSecretFiles(snapshotRoot, excludedContentCounts);
  return {
    path: snapshotRoot,
    sourceRoot,
    copyPid: child.pid,
    copyStartedAtUtc,
    copyCompletedAtUtc: new Date().toISOString(),
    excludedContentCounts,
    semantics: "private dependency copy; generated .vite cache, dotenv files, credentials, and key material removed before the exporter hashes or builds it",
  };
}

async function removeDependencyCacheAndSecretFiles(root, counts) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    const category = dependencyExcludedCategory(entry.name, entry.isDirectory());
    if (category) {
      counts[category] = (counts[category] ?? 0) + 1;
      await rm(path, { recursive: true, force: true });
      continue;
    }
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink(), "isolated Mobile dependency snapshot must not contain symlinks");
    if (info.isDirectory()) await removeDependencyCacheAndSecretFiles(path, counts);
  }
}

function dependencyExcludedCategory(name, isDirectory) {
  if (isDirectory && name === ".vite") return "generated-vite-cache-directory";
  if (name === ".env" || /^\.env\.(?!example(?:\.|$))/i.test(name)) return "environment-file";
  if ([".npmrc", "credentials.json", "account_credentials.json"].includes(name)) return "credential-file";
  if (/(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name)) return "credential-named-file";
  if (/\.(?:pem|key|p12|pfx|keystore)$/i.test(name)) return "cryptographic-key-material";
  return null;
}

async function copyArtifactTree(sourceRoot, destinationRoot) {
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const source = resolve(sourceRoot, entry.name);
    const destination = resolve(destinationRoot, entry.name);
    const info = await lstat(source);
    assert.ok(!info.isSymbolicLink(), "exported Mobile Web bundle must not contain symlinks");
    if (info.isDirectory()) await copyArtifactTree(source, destination);
    else if (info.isFile()) await copyFile(source, destination);
  }
}

function excludedCategory(name, isDirectory) {
  if (isDirectory && ["node_modules", ".expo", ".git", "dist", "target"].includes(name)) return "generated-or-dependency-directory";
  if (name === ".env" || /^\.env\.(?!example(?:\.|$))/i.test(name)) return "environment-file";
  if ([".npmrc", "credentials.json", "account_credentials.json"].includes(name)) return "credential-file";
  if (/\.(?:pem|key|p12|pfx|keystore)$/i.test(name)) return "cryptographic-key-material";
  return null;
}

async function hashComplement(mobileRoot, sharedRoot) {
  const files = [];
  await appendFileHashes(mobileRoot, "apps/kcoder-studio/mobile", files, new Set(["src"]));
  await appendFileHashes(sharedRoot, "apps/kcoder-studio/shared", files, new Set(["gatewayConnectionBudget.ts"]));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return sha256(Buffer.from(JSON.stringify(files)));
}

async function appendFileHashes(root, repoRelativeRoot, output, excludedNames) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (excludedCategory(entry.name, entry.isDirectory()) || excludedNames.has(entry.name)) continue;
    const absolute = resolve(root, entry.name);
    const repoRelative = `${repoRelativeRoot}/${entry.name}`;
    const info = await lstat(absolute);
    assert.ok(!info.isSymbolicLink(), `complement source contains a symlink: ${repoRelative}`);
    if (info.isDirectory()) await appendFileHashes(absolute, repoRelative, output, new Set());
    else if (info.isFile()) output.push({ path: repoRelative, sha256: sha256(await readFile(absolute)) });
  }
}

async function listFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(relative(root, absolute).split(sep).join("/"));
    }
  }
  await visit(root);
  return output.sort();
}

async function pruneEmptyDirectories(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = resolve(root, entry.name);
    await pruneEmptyDirectories(child);
    if ((await readdir(child)).length === 0) await rmdir(child);
  }
}

async function runPhoneUxFaultScenarios(chromium, gateway, network, gatewayCalls, browserErrors, context, refreshBackgroundHost) {
  const rows = [];
  const requiredScenarioFailures = [];
  let receiptSummary = null;
  const persistProgress = () => {
    const completedScenarioCount = rows.filter(row => ["PASS", "SMOKE", "DIAGNOSTIC_ONLY", "PARTIAL", "FAIL"].includes(row.status)).length;
    const expectedScenarioCount = selectedFaultScenario ? 1 : faultScenarioIds.length;
    const partialCoverage = rows.some(row => row.checks.coverageStatus && !["PASS", "FAIL", "SMOKE", "DIAGNOSTIC_ONLY"].includes(row.checks.coverageStatus));
    const progressArtifactName = `phone-ux-fault-progress-${String(completedScenarioCount).padStart(2, "0")}.json`;
    return context.writeArtifactJson(progressArtifactName, {
      schemaVersion: 1,
      status: rows.some(row => row.status === "FAIL")
        ? "PARTIAL_FAIL"
        : rows.some(row => row.status === "DIAGNOSTIC_ONLY") ? "DIAGNOSTIC_ONLY"
          : rows.some(row => row.status === "SMOKE") ? "SMOKE_ONLY"
          : partialCoverage ? "PARTIAL_COVERAGE"
          : completedScenarioCount >= expectedScenarioCount ? "PASS_SCOPED" : "RUNNING",
      selectedScenario: selectedFaultScenario ?? "all-required-fault-scenarios",
      completedScenarioCount,
      expectedScenarioCount,
      faults: rows,
      requiredScenarioFailures,
      fixtureReceiptLedger: receiptSummary,
      network: summarizeNetwork(network),
      browserErrors,
      gatewayCalls,
    });
  };
  const runCase = async (scenarioId, delayControl, exercise, { skipPageSetup = false, beforeFixtureSessionVisible } = {}) => {
    if (selectedFaultScenario && selectedFaultScenario !== scenarioId) return null;
    const row = {
      scenario: scenarioId,
      status: "RUNNING",
      evidenceClass: "real Mobile Web page in isolated Chromium context plus KCODER_STUDIO_MOCK Gateway fixture",
      checks: {},
    };
    const scenarioControl = { ...delayControl, delayMs: delayControl.delayMs ?? 0, scenarioId };
    network.currentStage = `fault:${scenarioId}:home`;
    let page;
    const startedAt = performance.now();
    try {
      if (!skipPageSetup) {
        page = await newMobilePage(chromium, network, scenarioControl, gatewayCalls, browserErrors, context);
        await connectMobile(page, gateway, {
          beforeFixtureSessionVisible: beforeFixtureSessionVisible ? () => beforeFixtureSessionVisible(page, row) : undefined,
        });
      }
      await exercise(page, row, scenarioControl);
      row.drain = await waitForGatewayRpcQuiescence(network, 35_000, 200);
      row.status = refreshDiagnosticMode && scenarioId === refreshScenarioId
        ? row.checks.coverageStatus === "DIAGNOSTIC_ONLY" ? "DIAGNOSTIC_ONLY" : "PARTIAL"
        : refreshSmokeMode && scenarioId === refreshScenarioId && row.checks.coverageStatus === "SMOKE"
          ? "SMOKE"
          : refreshSmokeMode && scenarioId === refreshScenarioId ? "PARTIAL" : "PASS";
    } catch (error) {
      row.status = "FAIL";
      row.error = context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 700);
      if (page && !page.isClosed()) row.pageAtFailure = await describeVisiblePage(page);
      requiredScenarioFailures.push({ scenario: scenarioId, reason: row.error });
    } finally {
      row.durationMs = round(performance.now() - startedAt);
      if (page) await closeOwnedMobilePage(page).catch(() => {});
      if (!(["PASS", "SMOKE", "DIAGNOSTIC_ONLY"].includes(row.status))) {
        try { await waitForGatewayRpcQuiescence(network, 2_000, 100); } catch {}
      }
      rows.push(row);
      await persistProgress();
    }
    return row;
  };

  await runCase("slow-status-12s", { statusProbeDelayMs: 12_000 }, async (page, row) => {
    const statusRequest = await waitFor(() => network.httpRouteRequests.find(item => item.scenario === row.scenario && item.apiPath === "/api/servers/status"), 10_000, "slow status probe request");
    await page.getByTestId("server-status-refreshing").waitFor({ state: "visible", timeout: 8_000 });
    row.checks.statusRefreshingVisible = true;
    row.checks.statusRequestStartedAtEpochMs = statusRequest.startedAtEpochMs;
    network.currentStage = `fault:${row.scenario}:history-before-status-response`;
    const historyStartedAt = performance.now();
    await openFixtureSession(page);
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 8_000 });
    const historyVisibleMs = round(performance.now() - historyStartedAt);
    const statusResponseAlreadyReturned = network.httpResponsePathDelays.some(item => item.scenario === row.scenario && item.apiPath === "/api/servers/status");
    assert.equal(statusResponseAlreadyReturned, false, "history should become visible while the 12-second status response is still held");
    row.checks.historyVisibleBeforeSlowStatusResponse = true;
    row.checks.clickToHistoryVisibleMs = historyVisibleMs;
    assert.ok(historyVisibleMs < 10_000, `history appeared after ${historyVisibleMs}ms, while status is configured for 12000ms`);
    await waitForGatewayRpcQuiescence(network, 20_000, 200);
    const delayedStatus = network.httpResponsePathDelays.find(item => item.scenario === row.scenario && item.apiPath === "/api/servers/status");
    assertApplicationDelay(delayedStatus, 12_000, "slow /api/servers/status application response hold");
    row.checks.slowStatusResponseCompleted = true;
    row.checks.statusConfiguredDelayMs = delayedStatus.configuredDelayMs;
    row.checks.statusAppliedDelayMs = delayedStatus.appliedDelayMs;
    row.checks.statusDelayTimerToleranceMs = APPLICATION_DELAY_TIMER_TOLERANCE_MS;
  }, {
    beforeFixtureSessionVisible: async (page, row) => {
      const statusRequest = await waitFor(() => network.httpRouteRequests.find(item => item.scenario === row.scenario && item.apiPath === "/api/servers/status"), 10_000, "slow status probe request before session-list setup");
      await page.getByTestId("server-status-refreshing").waitFor({ state: "visible", timeout: 8_000 });
      const completed = network.httpResponsePathDelays.some(item => item.scenario === row.scenario && item.apiPath === "/api/servers/status");
      assert.equal(completed, false, "slow status response must still be held while the home route is becoming interactive");
      row.checks.statusRequestObservedBeforeSessionListSetup = true;
      row.checks.statusRefreshingVisibleBeforeSessionList = true;
      row.checks.statusResponseStillHeldBeforeSessionListSetup = true;
      row.checks.statusRequestStartedAtEpochMs = statusRequest.startedAtEpochMs;
    },
  });

  await runCase("status-http-401", { httpStatusOverrides: {} }, async (page, row, scenarioControl) => {
    await page.getByTestId(`thread-${THREAD_ID}`).waitFor({ state: "visible", timeout: 10_000 });
    row.checks.sessionRowVisibleBeforeStatus401 = true;
    scenarioControl.httpStatusOverrides["/api/servers/status"] = 401;
    // This is an endpoint-specific forced 401, not a token or session revoke.
    // Let server-list setup settle so the post-challenge UI can attempt the same
    // cold task route through its normal session-row interaction.
    scenarioControl.statusProbeDelayMs = 500;
    network.currentStage = `fault:${row.scenario}:status-401-reload`;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("reauthorize-active-profile").waitFor({ state: "visible", timeout: 15_000 });
    row.checks.reauthorizationChallengeAfterEndpointSpecific401 = true;
    row.checks.serverStatusErrorHiddenWhileReauthorizationRequired = !(await page.getByTestId("server-status-error").isVisible().catch(() => false));
    assert.equal(row.checks.serverStatusErrorHiddenWhileReauthorizationRequired, true, "a 401 must be presented as a reauthorization challenge, not a transient health-probe error");
    const reloadStage = `fault:${row.scenario}:status-401-reload`;
    const statusProbeResponses = network.httpResponsePathDelays.filter(item => item.scenario === row.scenario && item.stage === reloadStage && item.apiPath === "/api/servers/status");
    assert.ok(statusProbeResponses.length > 0 && statusProbeResponses.every(item => item.status === 401), "the isolated status probe must return the injected 401");
    row.checks.statusProbe401ResponseCount = statusProbeResponses.length;
    row.checks.injectedStatus401 = network.injectedHttpStatuses.some(item => item.scenario === row.scenario && item.apiPath === "/api/servers/status" && item.status === 401);
    assert.equal(row.checks.injectedStatus401, true, "the endpoint-specific 401 must be visible in the isolated HTTP route ledger");

    const coldTaskRouteStage = `fault:${row.scenario}:cold-task-route-after-endpoint-401`;
    network.currentStage = coldTaskRouteStage;
    await page.getByTestId(`thread-${THREAD_ID}`).waitFor({ state: "visible", timeout: 8_000 });
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    await page.getByText("无法打开任务", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    const coldResumeRequests = network.rpcEvents.filter(item => item.direction === "request" && item.method === "thread/resume" && item.stage === coldTaskRouteStage);
    row.checks.coldTaskRouteBlockedByReauthorization = true;
    row.checks.coldResumeRequestCountAfterChallenge = coldResumeRequests.length;
    assert.equal(coldResumeRequests.length, 0, "a task route opened after the reauthorization challenge must not issue a cold thread/resume request");
    row.evidenceBoundary = "TaskScreen routeError intercepts the cold task route; this scenario makes no claim that a previously hot cached transcript remains readable after auth revocation";
  });

  await runCase("runtime-model-catalog-slow-12s", {
    threadModelFixture: true,
    methodDelayMs: {},
  }, async (page, row, scenarioControl) => {
    network.currentStage = `fault:${row.scenario}:preference-setup`;
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });

    await page.getByTestId("conversation-model-selector").click();
    await page.getByTestId("conversation-model-mock-minimax").waitFor({ state: "visible", timeout: 10_000 });
    const preferenceCatalogRequest = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "runtime.models.list" && item.stage === `fault:${row.scenario}:preference-setup`), 10_000, "real model-picker runtime.models.list request");
    await page.getByTestId("conversation-model-mock-minimax").click();
    const highEffort = page.getByRole("radio", { name: "高", exact: true });
    await highEffort.waitFor({ state: "visible", timeout: 10_000 });
    await waitFor(() => highEffort.isEnabled(), 10_000, "model preference write to settle");
    await highEffort.click();
    await waitFor(async () => (await page.getByTestId("conversation-model-selector").innerText()).includes("高"), 10_000, "persisted high reasoning effort visible in the actual task selector");
    const modelPickerDialogs = page.getByRole("dialog").filter({ hasText: "模型与推理强度" });
    const dialogCount = await modelPickerDialogs.count();
    const modelPickerDialog = modelPickerDialogs.last();
    const closeModelPicker = modelPickerDialog.getByLabel("关闭", { exact: true });
    const closeLocatorProof = {
      dialogCount,
      ariaLabelCloseCount: await closeModelPicker.count(),
    };
    if (closeLocatorProof.ariaLabelCloseCount === 1) {
      Object.assign(closeLocatorProof, await closeModelPicker.evaluate(element => ({
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
        ariaDisabled: element.getAttribute("aria-disabled"),
      })));
    }
    row.checks.modelPickerCloseLocatorProof = closeLocatorProof;
    assert.ok(closeLocatorProof.dialogCount >= 1, "at least one active model-preference dialog must be present");
    assert.equal(closeLocatorProof.ariaLabelCloseCount, 1, "the active model-preference dialog must expose exactly one aria-label=关闭 control");
    await closeModelPicker.waitFor({ state: "visible", timeout: 10_000 });
    await waitFor(() => closeModelPicker.isEnabled(), 10_000, "model preference write to finish before closing the picker");
    await closeModelPicker.click();
    await waitFor(async () => (await modelPickerDialogs.count()) === 0, 10_000, "all model-preference dialog layers to close");
    row.checks.preferenceSetThroughMobileUi = true;
    row.checks.preferenceCatalogRpcObserved = true;
    row.checks.preferencePickerClosedUsingVisibleCloseControl = true;
    row.checks.preferenceSetupRequestIdFingerprint = preferenceCatalogRequest.rpcIdFingerprint;

    await page.getByRole("button", { name: "返回" }).click();
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 10_000 });
    await ensureFixtureSessionVisible(page);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    await ensureFixtureSessionVisible(page);

    scenarioControl.methodDelayMs["runtime.models.list"] = 12_000;
    const routeSocketCountBeforeResume = network.routedWebSocketConnections.length;
    network.currentStage = `fault:${row.scenario}:task-reentry-with-persisted-effort`;
    const clickStartedAt = performance.now();
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    const request = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "runtime.models.list" && item.stage === network.currentStage), 10_000, "runtime.models.list from task resume with persisted effort");
    const responseAlreadyForwarded = network.rpcEvents.some(item => item.direction === "response-forwarded" && item.method === "runtime.models.list" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === request.stage);
    assert.equal(responseAlreadyForwarded, false, "runtime.models.list response must remain held during task re-entry");
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-input").fill(`PHONE_UX_MODEL_GATE_${Date.now()}`);
    assert.equal(await page.getByTestId("message-input").isEnabled(), true, "composer should remain editable during configuration restore");
    assert.equal(await page.getByTestId("send-message").isDisabled(), true, "sending must remain gated while runtime.models.list is pending");
    const clickToHistoryVisibleMs = round(performance.now() - clickStartedAt);
    assert.ok(clickToHistoryVisibleMs < 10_000, `history became visible after ${clickToHistoryVisibleMs}ms with model catalog held for 12000ms`);
    const restoredPreferenceLabel = await page.getByTestId("conversation-model-selector").innerText();
    assert.ok(restoredPreferenceLabel.includes("高"), "the model effort selected before reload must be restored into the active task UI");
    row.checks.resumeModelsListRequestObserved = true;
    row.checks.requestToHistoryVisibleMs = round(performance.now() - request.atMs);
    row.checks.clickToHistoryVisibleMs = clickToHistoryVisibleMs;
    row.checks.historyVisibleBeforeModelCatalogResponse = true;
    row.checks.persistedModelEffortHydratedOnResume = true;
    row.checks.composerEditableWhileModelCatalogPending = true;
    row.checks.sendDisabledWhileModelCatalogPending = true;
    row.checks.persistedModelEffort = "high";
    row.checks.threadResumeModelFixtureApplied = network.faultFixtureEvents.some(item => item.scenario === row.scenario && item.kind === "typed-thread-model-fixture" && item.method === "thread/resume");
    assert.equal(row.checks.threadResumeModelFixtureApplied, true, "thread/resume must provide the typed model identity used with the persisted reasoning preference");
    row.checks.routeSocketCountBeforeResume = routeSocketCountBeforeResume;

    const responseForwarded = await waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "runtime.models.list" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === request.stage), 20_000, "delayed runtime.models.list response");
    const delayedResponse = network.websocketResponsePathDelays.find(item => item.scenario === row.scenario && item.stage === request.stage && item.method === "runtime.models.list" && item.rpcIdFingerprint === request.rpcIdFingerprint);
    assertApplicationDelay(delayedResponse, 12_000, "task-resume runtime.models.list application response hold");
    const sendButton = page.getByTestId("send-message");
    await sendButton.waitFor({ state: "visible", timeout: 5_000 });
    const sendEnabledObservedAtMs = await waitFor(
      async () => (await sendButton.isEnabled()) ? performance.now() : null,
      5_000,
      "send to become enabled after model catalog restoration",
    );
    row.checks.modelCatalogApplicationDelayTimerToleranceMs = APPLICATION_DELAY_TIMER_TOLERANCE_MS;
    row.checks.modelCatalogResponseForwardedAtMs = responseForwarded.atMs;
    row.checks.sendEnabledObservedAtMs = round(sendEnabledObservedAtMs);
    row.checks.responseForwardedToSendEnabledObservedMs = round(sendEnabledObservedAtMs - responseForwarded.atMs);
    row.checks.sendEnabledAfterCatalogResponse = true;
    row.checks.modelCatalogResponseCompleted = true;
    row.checks.modelCatalogConfiguredDelayMs = delayedResponse.configuredDelayMs;
    row.checks.modelCatalogAppliedDelayMs = delayedResponse.appliedDelayMs;
  });

  await runCase("aux-agent-list-12s", {
    methodDelayMs: { "agent/list": 12_000 },
    testCapabilities: { agentSteering: true },
  }, async (page, row) => {
    network.currentStage = `fault:${row.scenario}:task-entry`;
    const clickStartedAt = performance.now();
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    const request = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "agent/list" && item.stage === `fault:${row.scenario}:task-entry`), 10_000, "capability-gated agent/list request");
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 8_000 });
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 8_000 });
    const historyVisibleAt = performance.now();
    const historyVisibleAfterRequestMs = round(historyVisibleAt - request.atMs);
    const clickToHistoryVisibleMs = round(historyVisibleAt - clickStartedAt);
    const responseAlreadyReturned = network.rpcEvents.some(item => item.direction === "response-forwarded" && item.method === "agent/list" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === `fault:${row.scenario}:task-entry`);
    assert.equal(responseAlreadyReturned, false, "history must render before the slow agent/list response");
    assert.ok(historyVisibleAfterRequestMs < 10_000, `history appeared after ${historyVisibleAfterRequestMs}ms with agent/list held for 12000ms`);
    await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 8_000 });
    assert.equal(await page.getByTestId("message-input").isEnabled(), true, "an optional agent/list response must not gate the editable composer");
    const forwarded = await waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "agent/list" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === request.stage), 20_000, "delayed agent/list response");
    const delayedResponse = network.websocketResponsePathDelays.find(item => item.scenario === row.scenario && item.stage === request.stage && item.method === "agent/list" && item.rpcIdFingerprint === request.rpcIdFingerprint);
    assertApplicationDelay(delayedResponse, 12_000, "agent/list application response hold");
    row.checks.auxiliaryDelayTimerToleranceMs = APPLICATION_DELAY_TIMER_TOLERANCE_MS;
    row.checks.testCapabilityInjected = true;
    row.checks.agentListRequestObserved = true;
    row.checks.historyVisibleBeforeAuxiliaryResponse = true;
    row.checks.composerEditableWhileAuxiliaryResponsePending = true;
    row.checks.agentListResponseCompleted = Boolean(forwarded);
    row.checks.auxiliaryResponseAppliedDelayMs = delayedResponse.appliedDelayMs;
    row.checks.requestToHistoryVisibleMs = historyVisibleAfterRequestMs;
    row.checks.clickToHistoryVisibleMs = clickToHistoryVisibleMs;
    row.checks.auxiliaryResponseConfiguredDelayMs = delayedResponse.configuredDelayMs;
  });

  await runCase("send-pending-2500ms", { methodResponseHoldMs: { "turn/start": 2_500 } }, async (page, row) => {
    network.currentStage = `fault:${row.scenario}:send-pending`;
    await openFixtureSession(page);
    const message = `PHONE_UX_PENDING_FIXTURE_${Date.now()}`;
    await page.getByTestId("message-input").fill(message);
    const priorStarts = network.rpcMethodCounts["turn/start"] ?? 0;
    const clickStartedAt = performance.now();
    await page.getByTestId("send-message").click();
    const pendingCard = page.getByTestId("failed-submission").filter({ hasText: message });
    await pendingCard.getByTestId("failed-submission-content").waitFor({ state: "visible", timeout: 2_000 });
    await pendingCard.getByText("正在发送，恢复记录已保存", { exact: true }).waitFor({ state: "visible", timeout: 2_000 });
    const pendingVisibleMs = round(performance.now() - clickStartedAt);
    const request = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "turn/start" && item.stage === `fault:${row.scenario}:send-pending`), 5_000, "mock turn/start pending request");
    const responseAlreadyForwarded = network.rpcEvents.some(item => item.direction === "response-forwarded" && item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === `fault:${row.scenario}:send-pending`);
    assert.equal(responseAlreadyForwarded, false, "the local pending UI should appear before the delayed turn/start response");
    assert.ok((network.rpcMethodCounts["turn/start"] ?? 0) - priorStarts === 1, "one send gesture must emit exactly one mock turn/start request");
    assert.ok(network.pendingRpcMethodCounts["turn/start"] > 0, "turn/start must remain in flight while the pending UI is observed");
    row.checks.pendingDraftVisibleBeforeAck = true;
    row.checks.localRecoveryRecordPersistedBeforeAck = true;
    row.checks.pendingCardVisibleMs = pendingVisibleMs;
    row.checks.turnStartRequestCountForGesture = 1;
    await page.getByTestId("stop-turn").waitFor({ state: "visible", timeout: 15_000 });
    const ack = await waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === request.stage), 10_000, "delayed mock turn/start response");
    const startObserved = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-start-request" && item.rpcIdFingerprint === request.rpcIdFingerprint), 5_000, "turn/start thread identity at the isolated route");
    assert.equal(startObserved.routeSocketId, request.routeSocketId, "turn/start identity must come from the same routed WebSocket request");
    assert.ok(startObserved.threadIdFingerprint, "the isolated turn/start request must include a thread identity fingerprint");
    const turnStarted = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-lifecycle-frame" && item.method === "turn/started" && item.routeSocketId === startObserved.routeSocketId && item.threadIdFingerprint === startObserved.threadIdFingerprint && item.atMs >= startObserved.atMs), 5_000, "same-route turn/started identity");
    assert.ok(turnStarted.turnIdFingerprint, "the actual turn/started notification must include a turn identity fingerprint");
    const turnCompleted = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-lifecycle-frame" && item.method === "turn/completed" && item.routeSocketId === turnStarted.routeSocketId && item.threadIdFingerprint === turnStarted.threadIdFingerprint && item.turnIdFingerprint === turnStarted.turnIdFingerprint), 10_000, "same-route terminal notification before delayed ACK");
    assert.equal(ack.routeSocketId, startObserved.routeSocketId, "the delayed turn/start ACK must belong to the same route socket");
    assert.ok(turnStarted.atMs >= startObserved.atMs, "turn/started must follow its exact turn/start request");
    assert.ok(turnCompleted.atMs < ack.atMs, "the exact same-route turn must actually complete before its delayed ACK is forwarded");
    const ackHold = await waitFor(() => network.methodResponseHolds.find(item => item.method === "turn/start" && item.configuredHoldMs === 2_500), 5_000, "measured turn/start response hold");
    assertApplicationDelay({ configuredDelayMs: ackHold.configuredHoldMs, appliedDelayMs: ackHold.measuredHoldMs }, 2_500, "mock turn/start response hold");
    row.checks.mockAckForwardedAfterPending = Boolean(ack);
    row.checks.turnLifecycleExactThreadTurnRoute = {
      threadIdFingerprint: startObserved.threadIdFingerprint,
      turnIdFingerprint: turnStarted.turnIdFingerprint,
      routeSocketId: turnStarted.routeSocketId,
    };
    row.checks.turnCompletedBeforeAckMs = round(ack.atMs - turnCompleted.atMs);
    row.checks.responseHoldConfiguredMs = ackHold.configuredHoldMs;
    row.checks.responseHoldAppliedMs = ackHold.measuredHoldMs;
    row.checks.responseHoldTimerToleranceMs = APPLICATION_DELAY_TIMER_TOLERANCE_MS;
    await assertRunningControlsStayHiddenAfterTwoFrames(page, "turn completed before ACK; a late ACK must not revive running UI");
    await waitForGatewayRpcQuiescence(network, 10_000, 200);
    await assertRunningControlsStayHiddenAfterTwoFrames(page, "after network quiescence, a late ACK must not revive running UI");
    row.checks.runningControlsStayedHiddenAfterAckTwoFramesAndNetworkQuiescence = true;
  });

  await runCase("approval-live-turn-interrupt-same-route", {}, async (page, row) => {
    network.currentStage = `fault:${row.scenario}:live-approval-turn`;
    await openFixtureSession(page);
    const message = `MOBILE_APPROVAL_PHONE_UX_${Date.now()}`;
    const priorStarts = network.rpcMethodCounts["turn/start"] ?? 0;
    await page.getByTestId("message-input").fill(message);
    await page.getByTestId("send-message").click();
    await page.getByTestId("approval-card").waitFor({ state: "visible", timeout: 15_000 });
    const stopButton = page.getByTestId("stop-turn");
    await stopButton.waitFor({ state: "visible", timeout: 10_000 });
    const startRequest = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "turn/start" && item.stage === `fault:${row.scenario}:live-approval-turn`), 5_000, "MOBILE_APPROVAL turn/start request");
    assert.equal((network.rpcMethodCounts["turn/start"] ?? 0) - priorStarts, 1, "the approval fixture must start one isolated turn");
    const startObserved = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-start-request" && item.rpcIdFingerprint === startRequest.rpcIdFingerprint), 5_000, "approval turn thread identity");
    const turnStarted = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-lifecycle-frame" && item.method === "turn/started" && item.routeSocketId === startObserved.routeSocketId && item.threadIdFingerprint === startObserved.threadIdFingerprint), 5_000, "approval turn started on its route");
    assert.equal(startObserved.routeSocketId, startRequest.routeSocketId, "the turn identity must match the actual request route");
    assert.ok(turnStarted.turnIdFingerprint, "the approval turn must expose its actual turn identity fingerprint");
    row.checks.approvalUiVisibleForHeldMockTurn = true;
    row.checks.activeTurnRouteSocketId = turnStarted.routeSocketId;

    await stopButton.click();
    const interruptRequest = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-interrupt-request" && item.threadIdFingerprint === turnStarted.threadIdFingerprint && item.turnIdFingerprint === turnStarted.turnIdFingerprint), 10_000, "same-route turn/interrupt request");
    assert.equal(interruptRequest.routeSocketId, turnStarted.routeSocketId, "the stop gesture must interrupt the exact active turn on its owning route");
    const interruptResponse = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-interrupt-upstream-response" && item.rpcIdFingerprint === interruptRequest.rpcIdFingerprint && item.routeSocketId === turnStarted.routeSocketId && item.stage === interruptRequest.stage), 10_000, "upstream turn/interrupt response on the same route and scenario stage");
    assert.equal(interruptResponse.interrupted, true, "the isolated Gateway must acknowledge interruption of the active turn");
    assert.equal(interruptResponse.routeSocketId, turnStarted.routeSocketId, "the interrupt response must use the turn's owning route");
    assert.equal(interruptResponse.threadIdFingerprint, turnStarted.threadIdFingerprint, "the interrupt response must match the active thread");
    assert.equal(interruptResponse.turnIdFingerprint, turnStarted.turnIdFingerprint, "the interrupt response must match the active turn");
    const interruptForwarded = await waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "turn/interrupt" && item.rpcIdFingerprint === interruptRequest.rpcIdFingerprint && item.routeSocketId === turnStarted.routeSocketId && item.stage === interruptRequest.stage), 10_000, "turn/interrupt response forwarded on the same route and scenario stage");
    assert.equal(interruptForwarded.routeSocketId, turnStarted.routeSocketId, "the interrupt response delivered to the client must stay on the active turn route");
    const terminal = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-lifecycle-frame" && item.method === "turn/completed" && item.turnStatus === "interrupted" && item.routeSocketId === turnStarted.routeSocketId && item.threadIdFingerprint === turnStarted.threadIdFingerprint && item.turnIdFingerprint === turnStarted.turnIdFingerprint), 10_000, "same-route interrupted terminal notification");
    assert.ok(terminal.atMs >= interruptRequest.atMs, "the exact terminal notification must follow the stop request");
    assert.ok(terminal.atMs >= interruptForwarded.atMs, "the exact terminal notification must follow the interrupt response delivered to the client");
    await assertRunningControlsStayHiddenAfterTwoFrames(page, "same-route active-turn interrupt");
    row.checks = {
      ...row.checks,
      sameRouteInterruptRequestAndTerminal: true,
      interruptResponseAccepted: true,
      interruptResponseForwardedToClient: true,
      terminalStatus: terminal.turnStatus,
      terminalAfterInterruptMs: round(terminal.atMs - interruptRequest.atMs),
      exactThreadTurnRoute: {
        threadIdFingerprint: turnStarted.threadIdFingerprint,
        turnIdFingerprint: turnStarted.turnIdFingerprint,
        routeSocketId: turnStarted.routeSocketId,
      },
      runningControlsHiddenAfterTerminalAndTwoFrames: true,
    };
  });

  const receiptFixture = createAcceptedTurnReceiptFixture();
  const receiptScope = Object.freeze({});
  const startCountBeforeReceiptScenario = gatewayCalls.turnStart;
  const ackRow = await runCase("ack-loss-reconnect-exact-receipt", {
    testCapabilities: { turnReceiptsV1: true },
    receiptFixture,
    receiptScope,
    dropFirstResponseForMethod: "turn/start",
    closeAfterDroppedResponse: true,
  }, async (page, row) => {
    network.currentStage = `fault:${row.scenario}:send-and-drop-ack`;
    await openFixtureSession(page);
    const message = `PHONE_UX_ACK_FIXTURE_${Date.now()}`;
    await page.getByTestId("message-input").fill(message);
    await page.getByTestId("send-message").click();
    await waitFor(() => network.injectedWebSocketResponseDrops.find(item => item.scenario === row.scenario && item.method === "turn/start"), 15_000, "dropped isolated turn/start response");
    const dropped = network.injectedWebSocketResponseDrops.find(item => item.scenario === row.scenario && item.method === "turn/start");
    assert.equal(dropped.acceptedObservedFromMockGateway, true, "the dropped response must follow an actual successful isolated mock response");
    const readbackEvent = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-receipt-readback"), 25_000, "exact receipt readback after socket reconnect");
    assert.equal(readbackEvent.exactObservedAcceptanceMatched, true, "receipt readback must match the accepted thread/clientMessageId pair in this page scope");
    assert.notEqual(readbackEvent.routeSocketId, dropped.routeSocketId, "receipt readback must use the replacement WebSocket after the dropped-response close");
    await page.getByTestId("stop-turn").waitFor({ state: "visible", timeout: 20_000 });
    const summary = receiptFixture.summary();
    assert.equal(summary.turnStartRequestCount, 1, "ACK recovery must not retry turn/start or create a new clientMessageId");
    assert.equal(summary.duplicatePairRequestCount, 0, "ACK recovery must not resubmit the same clientMessageId");
    assert.equal(summary.acceptedResponseCount, 1, "only the one successful mock response may populate the fixture receipt");
    assert.equal(summary.receiptReadCount, 1, "the client should read one receipt for the ambiguous start");
    assert.equal(summary.receiptMismatchCount, 0, "the receipt lookup must remain scoped to the exact accepted pair");
    assert.equal(summary.acceptedIdentityFingerprints.length, 1, "there must be exactly one accepted identity, without a replacement ID");
    assert.equal(summary.acceptedIdentityFingerprints[0].receiptReadOnDifferentRouteSocket, true, "readback should be correlated across the expected reconnect but within one scenario scope");
    row.checks = {
      ...row.checks,
      droppedResponseAfterObservedMockAcceptance: true,
      routeSocketClosedAfterDrop: true,
      reconnectReceiptReadbackExactPair: true,
      turnStartRequestsAcrossRecovery: summary.turnStartRequestCount,
      duplicatePairRequests: summary.duplicatePairRequestCount,
      acceptedResponseCount: summary.acceptedResponseCount,
      receiptReadCount: summary.receiptReadCount,
      receiptMismatchCount: summary.receiptMismatchCount,
      acceptedIdentityFingerprints: summary.acceptedIdentityFingerprints,
      crossRouteStopCoverage: "UNVERIFIED: isolated mock keeps activeTurn on the original socket; this receipt scenario does not claim replacement-route interruption",
      mockActiveTurnOwnerRouteSocketId: dropped.routeSocketId,
      receiptReadbackRouteSocketId: readbackEvent.routeSocketId,
    };
  });
  receiptSummary = receiptFixture.summary();
  if (ackRow) {
    ackRow.checks.turnStartRequestCountForScenario = gatewayCalls.turnStart - startCountBeforeReceiptScenario;
    assert.equal(ackRow.checks.turnStartRequestCountForScenario, 1, "exact receipt recovery must not send a second turn/start");
  }

  await runCase("websocket-disconnect-and-reconnect", {
    disconnectAfterMethodResponse: "thread/read",
  }, async (page, row) => {
    network.currentStage = `fault:${row.scenario}:task-entry`;
    const priorSocketIds = new Set(network.routedWebSocketConnections.map(item => item.id));
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    const readResponse = await waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "thread/read" && item.stage === `fault:${row.scenario}:task-entry`), 15_000, "thread/read response before forced disconnect");
    const reconnectInitialize = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "initialize" && item.routeSocketId !== readResponse.routeSocketId && !priorSocketIds.has(item.routeSocketId) && item.stage === `fault:${row.scenario}:task-entry`), 25_000, "initialize request on replacement WebSocket");
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });
    const disconnectObserved = network.faultFixtureEvents.some(item => item.scenario === row.scenario && item.kind === "socket-closed-after-response" && item.method === "thread/read");
    assert.equal(disconnectObserved, true, "fixture must record the intentional WebSocket close after thread/read");
    row.checks = {
      ...row.checks,
      socketClosedAfterThreadRead: true,
      replacementInitializeObserved: Boolean(reconnectInitialize),
      historyStillVisible: true,
    };
  });

  const jitterSequence = [0, 100, 900, 300, 600];
  const jitter = createResponseJitter({
    http: { "/api/servers/status": jitterSequence },
    rpc: { "thread/read": jitterSequence },
  });
  await runCase("response-jitter-30", { responseJitter: jitter }, async (_unused, row) => {
    const pageSamples = [];
    const pairingSetupStage = `fault:${row.scenario}:pairing-setup`;
    let pairedProfileStorageState;
    let pairingPage;
    const pairingLoginResponses = [];
    let removePairingLoginObserver = () => {};
    network.currentStage = pairingSetupStage;
    try {
      pairingPage = await newMobilePage(chromium, network, { delayMs: 0, scenarioId: row.scenario }, gatewayCalls, browserErrors, context);
      removePairingLoginObserver = observeLoginResponses(pairingPage, pairingLoginResponses, pairingSetupStage, "setup");
      await connectMobile(pairingPage, gateway);
      await waitForGatewayRpcQuiescence(network, 15_000, 100);
      const pairingSessionRows = network.httpResponsePathDelays.filter(item => item.scenario === row.scenario && item.stage === pairingSetupStage && item.apiPath === "/api/mobile/session");
      assert.equal(pairingSessionRows.length, 1, "jitter setup must perform exactly one Mobile Gateway pairing");
      assert.equal(pairingSessionRows[0].status, 200, "jitter setup pairing must be accepted before repeated samples");
      pairedProfileStorageState = await pairingPage.context().storageState();
      await context.writeArtifactJson("phone-ux-jitter-pairing-setup.json", {
        schemaVersion: 1,
        scenario: row.scenario,
        status: "PASS",
        sampleClass: "single pairing setup; excluded from the 30 jitter page samples",
        pairingCount: pairingSessionRows.length,
        pairingResponseStatus: pairingSessionRows[0].status,
        profileStateLocation: "private in-memory Playwright storageState; never serialized to artifacts",
        loginResponses: pairingLoginResponses,
      });
    } catch (error) {
      const pageAtFailure = pairingPage && !pairingPage.isClosed() ? await describeVisiblePage(pairingPage).catch(() => null) : null;
      const screenshot = pairingPage && !pairingPage.isClosed()
        ? await capturePrivateFailureScreenshot(context, pairingPage, "phone-ux-jitter-pairing-setup-failure.png")
        : { artifact: null, status: "page-unavailable" };
      await context.writeArtifactJson("phone-ux-jitter-pairing-setup.json", {
        schemaVersion: 1,
        scenario: row.scenario,
        status: "FAIL",
        sampleClass: "single pairing setup; excluded from the 30 jitter page samples",
        profileStateLocation: "private in-memory Playwright storageState; never serialized to artifacts",
        pageAtFailure,
        loginResponses: pairingLoginResponses,
        apiResponses: network.httpResponsePathDelays
          .filter(item => item.scenario === row.scenario && item.stage === pairingSetupStage)
          .map(summarizeHttpDelaySample),
        screenshot,
        error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 700),
      });
      throw error;
    } finally {
      removePairingLoginObserver();
      if (pairingPage) await closeOwnedMobilePage(pairingPage).catch(() => {});
    }
    row.checks.pairingSetup = {
      pairingCount: 1,
      pairingSetupSampleExcludedFromJitterN30: true,
      profileStateReusedInMemory: true,
      repeatedSamplesUseFreshBrowserContexts: true,
    };

    for (let index = 0; index < 30; index += 1) {
      const sampleId = String(index + 1).padStart(2, "0");
      const stage = `fault:${row.scenario}:sample-${sampleId}`;
      network.currentStage = stage;
      let page;
      const loginResponses = [];
      const failedRequestPaths = [];
      let removeLoginObserver = () => {};
      const failedRequestObserver = request => failedRequestPaths.push(safePath(request.url()));
      const sampleStartedAt = performance.now();
      let sampleResult = {
        schemaVersion: 1,
        scenario: row.scenario,
        sampleId,
        status: "RUNNING",
        sampleClass: "cold runtime in fresh BrowserContext with the single paired profile restored",
        pairingCountForThisSample: 0,
        profileStateLocation: "private in-memory Playwright storageState; never serialized to artifacts",
        stage,
        homeNavigation: null,
        homeReadyMs: null,
        clickToHistoryVisibleMs: null,
      };
      let sampleError = null;
      try {
        page = await newMobilePage(chromium, network, { delayMs: 0, scenarioId: row.scenario, responseJitter: jitter }, gatewayCalls, browserErrors, context, pairedProfileStorageState);
        removeLoginObserver = observeLoginResponses(page, loginResponses, stage, sampleId);
        page.on("requestfailed", failedRequestObserver);
        const homeNavigationStartedAt = performance.now();
        const homeResponse = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
        page.__phoneUxLastNavigationStatus = homeResponse?.status() ?? null;
        const homeNavigation = { path: safePath(homeResponse?.url() ?? page.url()), status: homeResponse?.status() ?? null };
        sampleResult.homeNavigation = homeNavigation;
        assert.equal(homeResponse?.status(), 200, "paired profile should restore the isolated Gateway home");
        await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 60_000 });
        await ensureFixtureSessionVisible(page);
        const homeReadyMs = round(performance.now() - homeNavigationStartedAt);
        sampleResult.homeReadyMs = homeReadyMs;
        await waitForGatewayRpcQuiescence(network, 15_000, 100);
        const repeatedPairingRows = network.httpResponsePathDelays.filter(item => item.scenario === row.scenario && item.stage === stage && item.apiPath === "/api/mobile/session");
        assert.equal(repeatedPairingRows.length, 0, `jitter sample ${sampleId} must reuse the one paired profile without another pairing request`);
        const clickStartedAt = performance.now();
        await page.getByTestId(`thread-${THREAD_ID}`).click();
        await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
        await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });
        const clickToHistoryVisibleMs = round(performance.now() - clickStartedAt);
        sampleResult.clickToHistoryVisibleMs = clickToHistoryVisibleMs;
        await waitForGatewayRpcQuiescence(network, 15_000, 100);
        const statusRows = network.httpResponsePathDelays.filter(item => item.scenario === row.scenario && item.stage === stage && item.apiPath === "/api/servers/status");
        const readRows = network.websocketResponsePathDelays.filter(item => item.scenario === row.scenario && item.stage === stage && item.method === "thread/read");
        assert.ok(statusRows.length > 0, `jitter sample ${sampleId} must include a completed HTTP status response`);
        assert.ok(readRows.length > 0, `jitter sample ${sampleId} must include a completed thread/read response`);
        for (const sample of statusRows) {
          assert.ok(Number.isFinite(sample.jitterDelayMs) && jitterSequence.includes(sample.jitterDelayMs), `jitter sample ${sampleId} HTTP delay must be one of the configured fixture values`);
          assert.equal(sample.configuredDelayMs, sample.jitterDelayMs, `jitter sample ${sampleId} HTTP configured delay must preserve its fixture value`);
          assertApplicationDelay(sample, sample.jitterDelayMs, `jitter sample ${sampleId} HTTP application response hold`);
        }
        for (const sample of readRows) {
          assert.ok(Number.isFinite(sample.jitterDelayMs) && jitterSequence.includes(sample.jitterDelayMs), `jitter sample ${sampleId} WSS delay must be one of the configured fixture values`);
          assert.equal(sample.configuredDelayMs, sample.jitterDelayMs, `jitter sample ${sampleId} WSS configured delay must preserve its fixture value`);
          assertApplicationDelay(sample, sample.jitterDelayMs, `jitter sample ${sampleId} WSS application response hold`);
        }
        sampleResult = {
          ...sampleResult,
          status: "PASS",
          homeNavigation,
          homeReadyMs,
          taskShellVisible: true,
          historyFirstMessageVisible: true,
          clickToHistoryVisibleMs,
          httpRequests: network.httpRouteRequests
            .filter(item => item.scenario === row.scenario && item.stage === stage)
            .map(item => ({ path: sanitizeGatewayPath(item.apiPath ?? item.path), method: item.method })),
          httpStatusResponses: statusRows.map(summarizeHttpDelaySample),
          webSocketRequests: network.rpcEvents
            .filter(item => item.scenario === row.scenario && item.stage === stage && item.direction === "request")
            .map(item => ({ path: sanitizeGatewayPath(item.path), method: item.method, routeSocketId: item.routeSocketId })),
          threadReadResponses: readRows.map(summarizeWebSocketDelaySample),
          loginResponses,
          failedRequestPaths,
          elapsedMs: round(performance.now() - sampleStartedAt),
        };
        await context.writeArtifactJson(`phone-ux-jitter-sample-${sampleId}.json`, sampleResult);
        pageSamples.push({ sampleIndex: index, sampleId, stage, homeReadyMs, clickToHistoryVisibleMs, httpStatusResponses: statusRows.length, threadReadResponses: readRows.length });
      } catch (error) {
        sampleError = error;
        const pageAtFailure = page && !page.isClosed() ? await describeVisiblePage(page).catch(() => null) : null;
        const screenshot = page && !page.isClosed()
          ? await capturePrivateFailureScreenshot(context, page, `phone-ux-jitter-sample-${sampleId}-failure.png`)
          : { artifact: null, status: "page-unavailable" };
        sampleResult = {
          ...sampleResult,
          status: "FAIL",
          completedDomSamplesBeforeThisSample: pageSamples.length,
          pageAtFailure,
          loginResponses,
          failedRequestPaths,
          httpRequests: network.httpRouteRequests
            .filter(item => item.scenario === row.scenario && item.stage === stage)
            .map(item => ({ path: sanitizeGatewayPath(item.apiPath ?? item.path), method: item.method })),
          httpResponses: network.httpResponsePathDelays
            .filter(item => item.scenario === row.scenario && item.stage === stage)
            .map(summarizeHttpDelaySample),
          webSocketRequests: network.rpcEvents
            .filter(item => item.scenario === row.scenario && item.stage === stage && item.direction === "request")
            .map(item => ({ path: sanitizeGatewayPath(item.path), method: item.method, routeSocketId: item.routeSocketId })),
          webSocketResponses: network.websocketResponsePathDelays
            .filter(item => item.scenario === row.scenario && item.stage === stage)
            .map(summarizeWebSocketDelaySample),
          screenshot,
          error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 700),
          elapsedMs: round(performance.now() - sampleStartedAt),
        };
        await context.writeArtifactJson(`phone-ux-jitter-sample-${sampleId}.json`, sampleResult);
      } finally {
        removeLoginObserver();
        if (page) {
          page.off("requestfailed", failedRequestObserver);
          await closeOwnedMobilePage(page).catch(() => {});
        }
      }
      if (sampleError) throw sampleError;
    }
    const jitterSampleStage = item => item.scenario === row.scenario && /^fault:response-jitter-30:sample-\d+$/.test(item.stage);
    const httpRows = network.httpResponsePathDelays.filter(item => jitterSampleStage(item) && item.apiPath === "/api/servers/status");
    const rpcRows = network.websocketResponsePathDelays.filter(item => jitterSampleStage(item) && item.method === "thread/read");
    assert.equal(pageSamples.length, 30, "the jitter scenario must retain exactly thirty completed browser samples");
    assert.ok(httpRows.length >= 30, `only ${httpRows.length} completed status responses received jitter`);
    assert.ok(rpcRows.length >= 30, `only ${rpcRows.length} completed thread/read responses received jitter`);
    const applied = rows => rows.map(item => item.appliedDelayMs).filter(Number.isFinite).sort((a, b) => a - b);
    const historySamples = pageSamples.map(item => item.clickToHistoryVisibleMs).sort((a, b) => a - b);
    row.checks = {
      ...row.checks,
      requiredPageSamples: 30,
      completedPageSamples: pageSamples.length,
      pageSampleErrorCount: 0,
      clickToHistoryVisibleP50P95Ms: { p50: percentile(historySamples, 0.5), p95: percentile(historySamples, 0.95) },
      httpStatusResponseSamples: httpRows.length,
      websocketThreadReadResponseSamples: rpcRows.length,
      applicationDelayTimerToleranceMs: APPLICATION_DELAY_TIMER_TOLERANCE_MS,
      httpConfiguredJitterMs: distribution(httpRows.map(item => item.jitterDelayMs)),
      websocketConfiguredJitterMs: distribution(rpcRows.map(item => item.jitterDelayMs)),
      httpAppliedDelayP50P95Ms: { p50: percentile(applied(httpRows), 0.5), p95: percentile(applied(httpRows), 0.95) },
      websocketAppliedDelayP50P95Ms: { p50: percentile(applied(rpcRows), 0.5), p95: percentile(applied(rpcRows), 0.95) },
      pageSamples,
      delayDefinition: "configured HTTP/WSS response-path extra delay, not RTT, packet loss, or native radio network latency",
    };
  }, { skipPageSetup: true });

  await runCase("refresh-send-background-return-n30", {}, async (_unused, row) => {
    assert.equal(sampleCount, refreshSingleSampleMode ? 1 : DEFAULT_SAMPLES, refreshSingleSampleMode
      ? "single-sample refresh diagnostic requires exactly one sample per selected action and delay bin"
      : "refresh/send/background formal coverage requires thirty samples per action and delay bin");
    assert.deepEqual(
      delayValues,
      refreshDiagnosticMode ? [600] : refreshSmokeMode ? [0] : DEFAULT_DELAYS,
      refreshSendDiagnosticMode
        ? "accepted-600 diagnostic requires only the 600ms mock ACK hold"
        : refreshBackgroundDiagnosticMode
          ? "home-600 diagnostic requires only the 600ms /api/servers response hold"
        : refreshSmokeMode
          ? "refresh smoke requires only the zero-delay functional check"
          : "refresh/send/background formal coverage requires the 0/300/600/1000ms delay bins",
    );

    let pairedProfileStorageState;
    let pairingPage;
    let bootstrapAuth = null;
    let bootstrapAuthCleanup = null;
    const sharedDiagnosticContext = refreshBackgroundDiagnosticMode ? chromium.defaultContext : null;
    const backgroundVisibilityHelper = refreshBackgroundHost?.visibilityHelper ?? null;
    const mobilePageOptions = refreshBackgroundDiagnosticMode
      ? { browserContext: sharedDiagnosticContext, applyMobileEmulation: true, prepareViewportDocument: true }
      : undefined;
    const pairingStage = `fault:${row.scenario}:pairing-setup`;
    network.currentStage = pairingStage;
    try {
      pairingPage = await newMobilePage(
        chromium,
        network,
        { delayMs: 0, scenarioId: row.scenario, httpPathDelayMs: {}, methodResponseHoldMs: {} },
        gatewayCalls,
        browserErrors,
        context,
        undefined,
        mobilePageOptions,
      );
      if (formalOwnedAuthLifecycle) {
        const beforePair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
        assert.equal(beforePair.active, 0, "formal owned-auth samples must start with no active device grants");
        bootstrapAuth = observeOwnedMobileAuth(pairingPage, context);
      }
      if (refreshBackgroundDiagnosticMode) assert.equal(pairingPage.context(), sharedDiagnosticContext, "pairing page must use the one noDefaults BrowserContext");
      await connectMobile(pairingPage, gateway);
      if (bootstrapAuth) {
        await bootstrapAuth.waitForPair();
        const afterPair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
        assert.equal(afterPair.active, 1, "the formal bootstrap pair must create exactly one owned active device grant");
      }
      await waitForGatewayRpcQuiescence(network, 15_000, 100);
      if (!refreshBackgroundDiagnosticMode && !formalOwnedAuthLifecycle) pairedProfileStorageState = await pairingPage.context().storageState();
    } finally {
      if (bootstrapAuth && pairingPage) {
        try {
          bootstrapAuthCleanup = await releaseOwnedMobileAuthSample(pairingPage, gateway, bootstrapAuth, context);
        } catch (error) {
          bootstrapAuthCleanup = {
            status: "FAIL",
            failures: ["cleanup-helper-error"],
            error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 400),
          };
        }
      }
      if (pairingPage) {
        if (refreshBackgroundDiagnosticMode) await closeRefreshDiagnosticMobilePage(pairingPage);
        else await closeOwnedMobilePage(pairingPage).catch(() => {});
      }
    }
    if (bootstrapAuthCleanup) assert.equal(bootstrapAuthCleanup.status, "PASS", "formal bootstrap auth must be revoked/logged out before its BrowserContext closes");
    row.checks.pairing = {
      status: "PASS",
      bootstrapPairingCount: 1,
      setupExcludedFromSamples: true,
      profileStorageState: refreshBackgroundDiagnosticMode
        ? "same owned noDefaults default BrowserContext localStorage; no storageState export"
        : formalOwnedAuthLifecycle
          ? "formal samples use fresh per-sample UI login/pair; no bootstrap profile is reused"
          : "in-memory Playwright state only; not written to artifacts",
      sampleContexts: refreshBackgroundDiagnosticMode
        ? "single diagnostic page and pairing share the one noDefaults default BrowserContext"
        : formalOwnedAuthLifecycle
          ? "background: one freshly paired owned Chromium/default context per sample; send: one fresh BrowserContext paired independently per sample"
          : "background: one freshly paired owned Chromium/default context per sample; send: one fresh BrowserContext per sample restored from in-memory paired profile",
      backgroundPairingPolicy: refreshBackgroundDiagnosticMode
        ? "one selected home-600 diagnostic sample reuses its paired default context"
        : formalOwnedAuthLifecycle
          ? "every formal Home/Task/accepted/rejected sample uses a fresh owned pair and exact grant+web-session cleanup before the next sample"
          : "each Home/Task background sample is paired independently in its fresh noDefaults default context; bootstrap storageState is used only for send samples",
      formalOwnedAuthLifecycle: formalOwnedAuthLifecycle ? {
        status: "PER_SAMPLE_REQUIRED",
        bootstrapAuthCleanup,
        cleanupContract: "exact observed mobile access token DELETE 204; exact BrowserContext web cookie POST /logout 303; stale cookie protected request 401; owned device store active count 0 before context close",
      } : null,
    };

    const allGroups = [
      { id: "home-resume-list-retention", kind: "background", apiPath: "/api/servers", view: "home" },
      { id: "task-resume-history-retention", kind: "background", apiPath: "/api/servers/status", view: "task" },
      { id: "send-pending-accepted", kind: "accepted-send" },
      { id: "send-rejected-draft-retained", kind: "rejected-send" },
    ];
    const groups = refreshSendDiagnosticMode
      ? allGroups.filter(item => item.id === "send-pending-accepted")
      : refreshBackgroundDiagnosticMode
        ? allGroups.filter(item => item.id === "home-resume-list-retention")
      : allGroups;
    if (refreshSmokeMode) {
      assert.deepEqual(groups.map(item => item.id), [
        "home-resume-list-retention",
        "task-resume-history-retention",
        "send-pending-accepted",
        "send-rejected-draft-retained",
      ], "zero-delay smoke must exercise all four actions");
    }
    assert.equal(groups.length, refreshDiagnosticMode ? 1 : allGroups.length, "a single-action diagnostic must run only its selected action group");
    const groupResults = [];
    let totalFailedSamples = 0;
    let backgroundSamplePairingCount = 0;
    let formalAuthSampleCount = 0;
    let formalAuthCleanupCount = 0;
    let formalMaxActiveDeviceGrants = 0;
    const progressWriter = createRefreshProgressWriter((name, value) => context.writeArtifactJson(name, value));

    await progressWriter.write({
      schemaVersion: 1,
      scenario: row.scenario,
      status: "RUNNING",
      backgroundWindowSetup: refreshBackgroundWindowMode ? {
        hostStartupMs: refreshBackgroundHost?.setupElapsedMs ?? null,
        xvfbPid: refreshBackgroundHost?.display?.child?.pid ?? null,
        openboxPid: refreshBackgroundHost?.openbox?.pid ?? null,
        display: refreshBackgroundHost?.display?.display ?? null,
        policy: "one RunContext-owned Xvfb/Openbox host; a fresh owned noDefaults Chromium/default context per Home/Task sample",
      } : null,
      currentAction: null,
      currentDelayMs: null,
      attemptedSamplesInCurrentBin: 0,
      requiredSamplesPerBin: sampleCount,
      failedSamples: 0,
      completedGroups: [],
      currentBin: [],
      delayBins: delayValues,
      actionIds: groups.map(item => item.id),
      coverageMode: refreshCoverageMode,
      formalN30Coverage: !refreshSingleSampleMode,
      noProviderConfigured: true,
      gatewayEvidenceClass: "KCODER_STUDIO_MOCK; JS runMock except the explicit test-generated error fixture",
    });

    for (const group of groups) {
      const delayResults = [];
      for (const delayMs of delayValues) {
        const sampleResults = [];
        for (let index = 0; index < sampleCount; index += 1) {
          const sampleId = String(index + 1).padStart(2, "0");
          const stage = `fault:${row.scenario}:${group.id}:delay-${delayMs}:sample-${sampleId}`;
          const actionId = `${group.id}:delay-${delayMs}:sample-${sampleId}`;
          network.currentStage = stage;
          network.currentActionId = actionId;
          const sampleControl = {
            delayMs: 0,
            scenarioId: row.scenario,
            httpPathDelayMs: {},
            methodResponseHoldMs: {},
            ...(group.kind === "rejected-send" ? { turnStartErrorFixture: true } : {}),
          };
          const receiptFixture = group.kind === "accepted-send" ? createAcceptedTurnReceiptFixture() : null;
          if (receiptFixture) {
            sampleControl.receiptFixture = receiptFixture;
            sampleControl.receiptScope = {};
          }
          const sampleLifecycleStartedAt = performance.now();
          const sampleResult = {
            schemaVersion: 1,
            scenario: row.scenario,
            action: group.id,
            delayMs,
            sampleId,
            stage,
            actionId,
            status: "RUNNING",
            coverageMode: refreshCoverageMode,
            formalN30Coverage: !refreshSingleSampleMode,
            diagnosticId: refreshSendDiagnosticMode ? refreshSendDiagnostic : refreshBackgroundDiagnosticMode ? refreshBackgroundDiagnostic : null,
            evidenceClass: group.kind === "background"
              ? "real Mobile Web UI through isolated KCODER_STUDIO_MOCK Gateway; one fresh owned Chromium default context per background sample, actual window minimize/restore with trusted visibility, no Provider/model"
              : group.kind === "rejected-send"
              ? "real Mobile Web TaskRuntime plus test-generated request-id-correlated JSON-RPC error in Playwright WebSocket route; bypasses KCODER_STUDIO_MOCK runMock and is not Rust app-server rejection"
              : refreshBackgroundDiagnosticMode
                ? "real Mobile Home UI and app foreground refresh in owned headful Chromium; actual window minimize/restore with trusted visibility; isolated KCODER_STUDIO_MOCK Gateway, no Provider/model"
              : "real Mobile Web UI/TaskRuntime plus isolated KCODER_STUDIO_MOCK Gateway; no Provider configured or invoked",
            configuredHold: null,
            visibility: null,
            setupTimingsMs: {
              sharedWindowHostStartup: group.kind === "background" ? refreshBackgroundHost?.setupElapsedMs ?? null : null,
              sharedHostStartedBeforeSample: group.kind === "background" && refreshBackgroundHost !== null,
            },
            timingsMs: {},
          };
          let page;
          let sampleAuth = null;
          let sampleChromium = chromium;
          let ownsSampleChromium = false;
          let measurementStartedAt = null;
          if (group.kind === "background" && refreshBackgroundDiagnosticMode) {
            sampleResult.backgroundBrowser = {
              instanceKey: "home-600-diagnostic",
              pid: chromium.child.pid,
              cdpPort: chromium.cdpPort,
              display: chromium.display,
              noDefaults: true,
              freshDefaultContext: true,
              pairingAndStartupExcludedFromMeasuredIntervals: true,
            };
            sampleResult.setupTimingsMs.ownedChromiumStartup = chromium.startupElapsedMs;
            sampleResult.setupTimingsMs.pairingAndHomeReadyMs = null;
            sampleResult.sharedDiagnosticPairingCompletedBeforeSample = true;
          }
          let sampleError = null;
          try {
            if (group.kind === "background" && !refreshBackgroundDiagnosticMode) {
              const instanceKey = `${group.id}-d${delayMs}-s${sampleId}`;
              sampleChromium = await startRefreshBackgroundChromium(context, { host: refreshBackgroundHost, instanceKey });
              ownsSampleChromium = true;
              sampleResult.setupTimingsMs.ownedChromiumStartup = sampleChromium.startupElapsedMs;
              assert.equal(sampleChromium.browser.contexts().length, 1, "each background sample must use a fresh Chromium with one default BrowserContext");
              assert.equal(sampleChromium.defaultContext, sampleChromium.browser.contexts()[0], "each background sample must use the first and only noDefaults BrowserContext");

              const pairingStage = `${stage}:pairing-setup`;
              network.currentStage = pairingStage;
              network.currentActionId = `${actionId}:pairing-setup`;
              const pageSetupStartedAt = performance.now();
              page = await newMobilePage(
                sampleChromium,
                network,
                sampleControl,
                gatewayCalls,
                browserErrors,
                context,
                null,
                { browserContext: sampleChromium.defaultContext, applyMobileEmulation: true, prepareViewportDocument: true },
              );
              assert.equal(page.context(), sampleChromium.defaultContext, "background sample page must belong to its fresh default BrowserContext");
              sampleResult.setupTimingsMs.mobilePageSetup = round(performance.now() - pageSetupStartedAt);
              const pairingStartedAt = performance.now();
              if (formalOwnedAuthLifecycle) {
                const beforePair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
                assert.equal(beforePair.active, 0, "the previous formal sample must release its device grant before the next pair");
                sampleAuth = observeOwnedMobileAuth(page, context);
                formalAuthSampleCount += 1;
              }
              await connectMobile(page, gateway);
              if (sampleAuth) {
                await sampleAuth.waitForPair();
                const afterPair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
                assert.equal(afterPair.active, 1, "each formal background pair must be the only active device grant");
                formalMaxActiveDeviceGrants = Math.max(formalMaxActiveDeviceGrants, afterPair.active);
              }
              await waitForGatewayRpcQuiescence(network, 15_000, 100);
              backgroundSamplePairingCount += 1;
              sampleResult.setupTimingsMs.pairingAndHomeReady = round(performance.now() - pairingStartedAt);
              sampleResult.backgroundBrowser = {
                instanceKey,
                pid: sampleChromium.child.pid,
                cdpPort: sampleChromium.cdpPort,
                display: sampleChromium.display,
                noDefaults: true,
                freshDefaultContext: true,
                pairingAndStartupExcludedFromMeasuredIntervals: true,
              };
              network.currentStage = stage;
              network.currentActionId = actionId;
            } else {
              page = await newMobilePage(
                chromium,
                network,
                sampleControl,
                gatewayCalls,
                browserErrors,
                context,
                formalOwnedAuthLifecycle ? undefined : pairedProfileStorageState,
                mobilePageOptions,
              );
              if (refreshBackgroundDiagnosticMode && group.kind === "background") assert.equal(page.context(), sharedDiagnosticContext, "diagnostic sample page must use the same noDefaults BrowserContext as pairing");
              if (formalOwnedAuthLifecycle) {
                const beforePair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
                assert.equal(beforePair.active, 0, "the previous formal sample must release its device grant before the next pair");
                sampleAuth = observeOwnedMobileAuth(page, context);
                formalAuthSampleCount += 1;
                const pairingStage = `${stage}:pairing-setup`;
                network.currentStage = pairingStage;
                network.currentActionId = `${actionId}:pairing-setup`;
                const pairingStartedAt = performance.now();
                await connectMobile(page, gateway);
                await sampleAuth.waitForPair();
                const afterPair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
                assert.equal(afterPair.active, 1, "each formal send pair must be the only active device grant");
                formalMaxActiveDeviceGrants = Math.max(formalMaxActiveDeviceGrants, afterPair.active);
                await waitForGatewayRpcQuiescence(network, 15_000, 100);
                sampleResult.setupTimingsMs.pairingAndHomeReady = round(performance.now() - pairingStartedAt);
                network.currentStage = stage;
                network.currentActionId = actionId;
              } else {
                const homeResponse = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
                page.__phoneUxLastNavigationStatus = homeResponse?.status() ?? null;
                assert.equal(homeResponse?.status(), 200, "paired profile must restore the isolated Gateway Home");
                await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
                await ensureFixtureSessionVisible(page);
                await waitForGatewayRpcQuiescence(network, 15_000, 100);
              }
            }

            if (group.kind === "background") {
              let initialMessageText = null;
              if (group.view === "task") {
                await openFixtureSession(page);
                await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
                const firstMessage = page.getByTestId("message-user").first();
                await firstMessage.waitFor({ state: "visible", timeout: 10_000 });
                initialMessageText = await firstMessage.innerText();
                sampleResult.initialHistoryTextFingerprint = sha256(initialMessageText).slice(0, 16);
              } else {
                const homeThreadRow = page.getByTestId(`thread-${THREAD_ID}`);
                await page.getByTestId(`toggle-server-${SERVER_ID}`).waitFor({ state: "visible", timeout: 10_000 });
                await homeThreadRow.waitFor({ state: "visible", timeout: 10_000 });
                const initialHomeThreadText = await homeThreadRow.innerText();
                sampleResult.initialHomeThreadTextFingerprint = sha256(initialHomeThreadText).slice(0, 16);
              }
              await waitForGatewayRpcQuiescence(network, 15_000, 100);
              const visibility = await backgroundVisibilityHelper.captureWindowMinimizeVisibilityCycle(page, {
                timeoutMs: 5_000,
                pollIntervalMs: 20,
                beforeMinimize: async () => {
                  const armed = await drainAndArmBackgroundHttpResponseHold({
                    waitForQuiescence: () => waitForGatewayRpcQuiescence(network, 15_000, 100),
                    sampleControl,
                    apiPath: group.apiPath,
                    delayMs,
                  });
                  sampleResult.preMinimizeQuiescence = armed.quiescence;
                  assert.equal(armed.status, "ARMED", "HTTP hold must only arm after Gateway HTTP and RPC activity is drained");
                  sampleResult.configuredHold = {
                    layer: "HTTP response path",
                    path: group.apiPath,
                    delayMs,
                    armedAfterQuiescence: true,
                    definition: "one-way application response hold after Gateway route fetch; not RTT or packet loss",
                  };
                  sampleResult.measurementOrigin = "after pre-minimize quiescence and hold arming; action intervals use actual trusted window/HTTP request timestamps, excluding browser startup and pairing";
                  sampleResult.measurementStartMonotonicMs = round(performance.now());
                  sampleResult.measurementClock = "Node monotonic; not compared directly with Chromium event epoch timestamps";
                  sampleResult.setupTimingsMs.preMeasurementReady = round(performance.now() - sampleLifecycleStartedAt);
                  measurementStartedAt = performance.now();
                },
                prepareCompanionPage: async companionPage => {
                  const companionEmulation = await applyRefreshBackgroundMobileEmulation(companionPage);
                  sampleResult.companionMobileFacts = { facts: companionEmulation.facts, gate: companionEmulation.gate, detachStatus: "pending" };
                  return async () => {
                    await companionEmulation.session.detach();
                    companionEmulation.detached = true;
                    sampleResult.companionMobileFacts.detachStatus = "acknowledged";
                  };
                },
              });
              sampleResult.visibility = visibility;
              const mainMobileRecord = REFRESH_BACKGROUND_MOBILE_SESSIONS.get(page);
              sampleResult.mainMobileFactsBeforeTransition = mainMobileRecord?.facts ?? null;
              sampleResult.mainMobileFactsAfterTransition = await readRefreshBackgroundMobileFacts(page);
              assert.equal(refreshBackgroundMobileFactsMatch(sampleResult.mainMobileFactsAfterTransition), true, "main Mobile page must retain its real CDP mobile metrics through the visibility cycle");
              const activeSampleChromium = sampleChromium;
              sampleResult.sameDefaultBrowserContext = activeSampleChromium.browser.contexts().length === 1
                && activeSampleChromium.browser.contexts()[0] === activeSampleChromium.defaultContext
                && page.context() === activeSampleChromium.defaultContext;
              sampleResult.visibilityChecks = {
                helperPass: visibility.status === "PASS",
                actualWindowMinimized: visibility.minimizedWindow?.bounds?.windowState === "minimized",
                actualWindowRestored: visibility.restoredWindow?.bounds?.windowState === "normal",
                trustedHiddenAfterMinimize: visibility.hiddenEvent?.isTrusted === true && visibility.hiddenEvent.atEpochMs > visibility.minimizeBoundaryEpochMs && visibility.hiddenState === "hidden",
                trustedVisibleAfterRestore: visibility.activeEvent?.isTrusted === true && visibility.activeEvent.atEpochMs > visibility.restoreBoundaryEpochMs && visibility.activeState === "visible",
                sameBrowserContext: visibility.targetOwnership?.sameBrowserContext === true,
                sameBrowserWindow: visibility.targetOwnership?.sameBrowserWindow === true,
                companionClosed: visibility.companionClosed === true,
                traceDetached: visibility.traceDetached === true,
                oneFreshNoDefaultsDefaultContext: sampleResult.sameDefaultBrowserContext,
                mainMetricsBefore: refreshBackgroundMobileFactsMatch(sampleResult.mainMobileFactsBeforeTransition),
                mainMetricsAfter: refreshBackgroundMobileFactsMatch(sampleResult.mainMobileFactsAfterTransition),
                companionMetrics: sampleResult.companionMobileFacts?.gate === true,
                companionMetricsDetached: sampleResult.companionMobileFacts?.detachStatus === "acknowledged",
                preMinimizeQuiescence: sampleResult.preMinimizeQuiescence?.status === "DRAINED",
                beforeMinimizeHookCompletedBeforeBoundary: visibility.beforeMinimizeHookStatus === "COMPLETED"
                  && visibility.completedStages.indexOf("check-main-page-visible") < visibility.completedStages.indexOf("before-minimize-hook")
                  && visibility.completedStages.indexOf("before-minimize-hook") < visibility.completedStages.indexOf("capture-minimize-boundary"),
                holdArmedBeforeMinimize: sampleResult.configuredHold?.armedAfterQuiescence === true
                  && visibility.beforeMinimizeHookStatus === "COMPLETED"
                  && visibility.completedStages.indexOf("before-minimize-hook") < visibility.completedStages.indexOf("capture-minimize-boundary"),
                noCleanupErrors: !visibility.cleanupError && !visibility.cleanupErrorStage && !visibility.restoreError && !visibility.restoreErrorStage && !visibility.traceError && !visibility.traceErrorStage && !visibility.cdpDetachError && !visibility.cdpDetachErrorStage && !visibility.companionPreparationCleanupError && !visibility.companionPreparationCleanupErrorStage,
              };
              if (visibility.status === "PASS") {
                for (const [name, passed] of Object.entries(sampleResult.visibilityChecks)) {
                  assert.equal(passed, true, `owned-window Mobile visibility gate failed: ${name}`);
                }
              }
              if (visibility.status !== "PASS") {
                sampleResult.status = "NOT_RUN";
                sampleResult.notRunReason = visibility.reason ?? "trusted visible-hidden-visible transition not observed";
              } else {
                const activeAtEpochMs = visibility.activeEvent.atEpochMs;
                const request = await waitFor(
                  () => network.httpRouteRequests.find(item => item.scenario === row.scenario
                    && item.stage === stage
                    && item.apiPath === group.apiPath
                    && item.startedAtEpochMs >= activeAtEpochMs),
                  5_000,
                  `${group.apiPath} request after trusted AppState active transition`,
                );
                sampleResult.activeEventAtEpochMs = activeAtEpochMs;
                sampleResult.refreshRequest = {
                  routeRequestOrdinal: request.routeRequestOrdinal,
                  path: request.apiPath,
                  method: request.method,
                  startedAtEpochMs: request.startedAtEpochMs,
                  activeToRequestMs: round(request.startedAtEpochMs - activeAtEpochMs),
                  afterActiveTransition: request.startedAtEpochMs >= activeAtEpochMs,
                };
                assert.equal(sampleResult.refreshRequest.afterActiveTransition, true, "the refresh request must follow the real active transition");

                const matchingResponse = () => findHttpResponseForRouteRequest(network.httpResponsePathDelays, request);
                const rowVisibleDuringHold = group.view === "home"
                  ? await page.getByTestId(`thread-${THREAD_ID}`).isVisible()
                  : await page.getByTestId("message-user").first().isVisible();
                assert.equal(rowVisibleDuringHold, true, "existing Home thread row or Task history must stay visible while refresh is pending");
                sampleResult.retainedVisibleBeforeResponse = true;
                if (group.view === "home") {
                  const currentHomeThreadText = await page.getByTestId(`thread-${THREAD_ID}`).innerText();
                  sampleResult.homeThreadTextFingerprintDuringHold = sha256(currentHomeThreadText).slice(0, 16);
                  assert.equal(sampleResult.homeThreadTextFingerprintDuringHold, sampleResult.initialHomeThreadTextFingerprint, "existing Home row content must remain unchanged while the foreground refresh is held");
                } else {
                  const currentMessageText = await page.getByTestId("message-user").first().innerText();
                  sampleResult.historyTextFingerprintDuringHold = sha256(currentMessageText).slice(0, 16);
                  assert.equal(sampleResult.historyTextFingerprintDuringHold, sampleResult.initialHistoryTextFingerprint, "existing Task history content must remain unchanged while the foreground refresh is held");
                }
                if (delayMs > 0) {
                  assert.equal(Boolean(matchingResponse()), false, "the configured positive response hold must still be pending when retention is checked");
                }
                const response = await waitFor(matchingResponse, Math.max(5_000, delayMs + 3_000), `${group.apiPath} refresh response`);
                assert.equal(response.routeRequestOrdinal, request.routeRequestOrdinal, "foreground response evidence must correlate to the exact post-active request ordinal");
                assertApplicationDelay(response, delayMs, `${group.id} HTTP refresh hold`);
                sampleResult.refreshResponseCorrelation = {
                  routeRequestOrdinal: response.routeRequestOrdinal,
                  matchesSelectedPostActiveRequest: response.routeRequestOrdinal === sampleResult.refreshRequest.routeRequestOrdinal,
                  configuredDelayMs: response.configuredDelayMs,
                  appliedDelayMs: response.appliedDelayMs,
                };
                if (group.view === "home") {
                  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 5_000 });
                  const homeThreadRow = page.getByTestId(`thread-${THREAD_ID}`);
                  await homeThreadRow.waitFor({ state: "visible", timeout: 5_000 });
                  if (group.view === "home") {
                    const finalHomeThreadText = await homeThreadRow.innerText();
                    sampleResult.homeThreadTextFingerprintAfterResponse = sha256(finalHomeThreadText).slice(0, 16);
                    assert.equal(sampleResult.homeThreadTextFingerprintAfterResponse, sampleResult.initialHomeThreadTextFingerprint, "existing Home row content must remain unchanged after the foreground refresh response");
                    sampleResult.postActiveMatchingRequestCount = network.httpRouteRequests.filter(item => item.scenario === row.scenario && item.stage === stage && item.apiPath === group.apiPath && item.startedAtEpochMs >= activeAtEpochMs).length;
                  }
                } else {
                  await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 5_000 });
                  const afterMessage = page.getByTestId("message-user").first();
                  await afterMessage.waitFor({ state: "visible", timeout: 5_000 });
                  const finalMessageText = await afterMessage.innerText();
                  assert.equal(sha256(finalMessageText), sha256(initialMessageText), "the previously visible history item must be unchanged after the refresh response");
                  sampleResult.finalHistoryTextFingerprint = sha256(finalMessageText).slice(0, 16);
                }
                sampleResult.retainedVisibleAfterResponse = true;
                sampleResult.response = summarizeHttpDelaySample(response);
                sampleResult.status = refreshBackgroundDiagnosticMode ? "DIAGNOSTIC" : refreshSmokeMode ? "SMOKE" : "PASS";
              }
            } else {
              measurementStartedAt = performance.now();
              await openFixtureSession(page);
              await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
              await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 10_000 });
              await waitForGatewayRpcQuiescence(network, 15_000, 100);
              sampleControl.methodResponseHoldMs["turn/start"] = delayMs;
              sampleResult.configuredHold = { layer: "WebSocket JSON-RPC response path", method: "turn/start", delayMs, definition: group.kind === "rejected-send" ? "test-generated request-id-correlated error response hold; bypasses mock Gateway runMock" : "isolated mock Gateway successful ACK hold; not RTT or packet loss" };

              const message = `PHONE_UX_${group.kind === "accepted-send" ? "ACCEPTED" : "REJECTED"}_${delayMs}_${sampleId}`;
              const priorStartCount = network.rpcMethodCounts["turn/start"] ?? 0;
              await page.getByTestId("message-input").fill(message);
              const clickStartedAt = performance.now();
              await page.getByTestId("send-message").click();
              const pendingCard = page.getByTestId("failed-submission").filter({ hasText: message });
              const zeroDelayAccepted = group.kind === "accepted-send" && delayMs === 0;
              const zeroDelayRejected = group.kind === "rejected-send" && delayMs === 0;
              if (zeroDelayAccepted) {
                const acceptedUserMessageForFeedback = page.getByTestId("message-user").filter({ hasText: message }).last();
                const firstFeedback = await Promise.any([
                  pendingCard.getByTestId("failed-submission-content").waitFor({ state: "visible", timeout: 5_000 })
                    .then(() => ({ kind: "pending-content", observedAtMs: performance.now() })),
                  acceptedUserMessageForFeedback.waitFor({ state: "visible", timeout: 5_000 })
                    .then(() => ({ kind: "accepted-user-message", observedAtMs: performance.now() })),
                ]);
                const clickToFirstFeedbackObservedMs = round(firstFeedback.observedAtMs - clickStartedAt);
                assert.ok(clickToFirstFeedbackObservedMs >= 0, "the first visible feedback sample must follow the send gesture");
                sampleResult.timingsMs.clickToFirstFeedbackObserved = clickToFirstFeedbackObservedMs;
                sampleResult.zeroDelayFeedbackEvidence = {
                  status: "FIRST_VISIBLE_FEEDBACK_OBSERVED",
                  kind: firstFeedback.kind,
                  observedAfterClickMs: clickToFirstFeedbackObservedMs,
                  observationSemantics: "Playwright locator visibility resolution is an observation upper bound, not a paint timestamp",
                };
                sampleResult.pendingUiEvidence = {
                  status: "NOT_REQUIRED_ZERO_DELAY_ACK_MAY_PRECEDE_DOM_SAMPLE",
                  reason: "A successful zero-delay ACK can remove the transient retrying-submission card before Playwright samples its pending label; exact request/ACK correlation, accepted transcript visibility, and no-duplicate checks are required below.",
                };
              } else if (zeroDelayRejected) {
                const pendingStatusForFeedback = pendingCard.getByText("正在发送，恢复记录已保存", { exact: true });
                const failedErrorForFeedback = pendingCard.getByTestId("failed-submission-error");
                const firstFeedback = await Promise.any([
                  pendingStatusForFeedback.waitFor({ state: "visible", timeout: 5_000 })
                    .then(() => ({ kind: "pending-status", observedAtMs: performance.now() })),
                  failedErrorForFeedback.waitFor({ state: "visible", timeout: 5_000 })
                    .then(() => ({ kind: "definite-failure-error", observedAtMs: performance.now() })),
                ]);
                const clickToFirstFeedbackObservedMs = round(firstFeedback.observedAtMs - clickStartedAt);
                assert.ok(clickToFirstFeedbackObservedMs >= 0, "the first rejected-send feedback sample must follow the send gesture");
                sampleResult.timingsMs.clickToFirstFeedbackObserved = clickToFirstFeedbackObservedMs;
                sampleResult.zeroDelayFeedbackEvidence = {
                  status: "FIRST_REJECTION_FEEDBACK_OBSERVED",
                  kind: firstFeedback.kind,
                  observedAfterClickMs: clickToFirstFeedbackObservedMs,
                  observationSemantics: "Playwright locator visibility resolution is an observation upper bound, not a paint timestamp",
                };
                sampleResult.pendingUiEvidence = {
                  status: "NOT_REQUIRED_ZERO_DELAY_REJECTION_MAY_PRECEDE_DOM_SAMPLE",
                  reason: "A zero-delay error response may transition the submission from pending to its definite failure card before Playwright samples the transient pending title; the first pending or error feedback is recorded, while exact request/error/route, retained draft, and no-automatic-retry checks remain required below.",
                };
              } else {
                await pendingCard.getByTestId("failed-submission-content").waitFor({ state: "visible", timeout: 5_000 });
                await pendingCard.getByText("正在发送，恢复记录已保存", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
                sampleResult.timingsMs.clickToLocalPending = round(performance.now() - clickStartedAt);
                sampleResult.pendingUiEvidence = { status: "OBSERVED_BEFORE_ACK", delayMs };
              }
              const request = await waitFor(
                () => network.rpcEvents.find(item => item.direction === "request" && item.method === "turn/start" && item.stage === stage),
                5_000,
                "single real client turn/start request",
              );
              assert.equal((network.rpcMethodCounts["turn/start"] ?? 0) - priorStartCount, 1, "one send gesture must create exactly one browser turn/start");
              const startIdentity = await waitFor(
                () => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-start-request" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage),
                5_000,
                "turn/start identity fingerprints at the routed WebSocket boundary",
              );
              assert.equal(startIdentity.routeSocketId, request.routeSocketId, "clientMessageId identity must belong to the same routed socket as this request");
              assert.ok(startIdentity.clientMessageIdFingerprint, "the actual turn/start must include a stable clientMessageId fingerprint");
              sampleResult.messageFingerprint = sha256(message).slice(0, 16);
              sampleResult.request = {
                method: request.method,
                rpcIdFingerprint: request.rpcIdFingerprint,
                clientMessageIdFingerprint: startIdentity.clientMessageIdFingerprint,
                threadIdFingerprint: startIdentity.threadIdFingerprint,
                routeSocketId: request.routeSocketId,
              };

              if (group.kind === "accepted-send") {
                const responseAlreadyForwarded = network.rpcEvents.some(item => item.direction === "response-forwarded" && item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage);
                if (delayMs > 0) {
                  assert.equal(responseAlreadyForwarded, false, "the delayed success ACK must remain pending when the local pending UI is observed");
                  assert.equal(
                    await pendingCard.getByText("正在发送，恢复记录已保存", { exact: true }).isVisible(),
                    true,
                    "the exact delayed turn/start must retain the pending UI while its ACK is still outstanding",
                  );
                  sampleResult.pendingUiEvidence = {
                    status: "OBSERVED_WITH_EXACT_ACK_OUTSTANDING",
                    delayMs,
                    rpcIdFingerprint: request.rpcIdFingerprint,
                    routeSocketId: request.routeSocketId,
                  };
                }
                const ack = await waitFor(
                  () => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage),
                  Math.max(10_000, delayMs + 5_000),
                  "successful isolated mock turn/start ACK with the exact request id",
                );
                const ackDetails = network.rpc.find(item => item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.routeSocketId === request.routeSocketId);
                assert.equal(ack.rpcIdFingerprint, request.rpcIdFingerprint, "the successful ACK must use the exact turn/start request id");
                assert.equal(ack.routeSocketId, request.routeSocketId, "the successful ACK must match the request route socket");
                assert.equal(ackDetails?.ok, true, "the isolated mock must return a successful turn/start ACK");
                assert.equal(ackDetails?.errorCode, undefined, "the accepted sample must not contain an error response");
                const responseDelay = network.websocketResponsePathDelays.find(item => item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage);
                if (delayMs > 0) {
                  const acceptedHold = network.methodResponseHolds.find(item => item.method === "turn/start" && item.configuredHoldMs === delayMs && item.stage === stage);
                  assertApplicationDelay(
                    { configuredDelayMs: acceptedHold?.configuredHoldMs, appliedDelayMs: acceptedHold?.measuredHoldMs },
                    delayMs,
                    "accepted turn/start response hold",
                  );
                } else {
                  assertApplicationDelay(responseDelay, 0, "zero-delay accepted turn/start response path");
                }
                const started = await waitFor(
                  () => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-lifecycle-frame" && item.method === "turn/started" && item.routeSocketId === request.routeSocketId && item.threadIdFingerprint === startIdentity.threadIdFingerprint && item.stage === stage),
                  10_000,
                  "same-route turn/started notification after successful ACK",
                );
                const completed = await waitFor(
                  () => network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-lifecycle-frame" && item.method === "turn/completed" && item.routeSocketId === request.routeSocketId && item.threadIdFingerprint === startIdentity.threadIdFingerprint && item.turnIdFingerprint === started.turnIdFingerprint && item.stage === stage),
                  20_000,
                  "same-route turn/completed notification",
                );
                assert.ok(completed.atMs > started.atMs, "the mock turn must finish after it starts");
                await page.getByTestId("stop-turn").waitFor({ state: "hidden", timeout: 5_000 });
                const acceptedUserMessage = page.getByTestId("message-user").filter({ hasText: message }).last();
                await acceptedUserMessage.waitFor({ state: "visible", timeout: 5_000 });
                assert.ok((await acceptedUserMessage.innerText()).includes(message), "the accepted user message must be visible in the transcript");
                const assistantMessage = page.getByTestId("message-assistant").last();
                await assistantMessage.waitFor({ state: "visible", timeout: 10_000 });
                assert.ok((await assistantMessage.innerText()).includes(message), "the TaskRuntime must render the accepted mock reply in the visible transcript");
                const stageTurnStartRequests = network.rpcEvents.filter(item => item.direction === "request" && item.method === "turn/start" && item.stage === stage);
                const stageTurnStartAcks = network.rpcEvents.filter(item => item.direction === "response-forwarded" && item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage);
                assert.equal(stageTurnStartRequests.length, 1, "the accepted action must not send a duplicate turn/start");
                assert.equal(stageTurnStartAcks.length, 1, "the exact accepted turn/start request must have one forwarded ACK");
                const receiptSummaryForSample = receiptFixture.summary();
                assert.equal(receiptSummaryForSample.turnStartRequestCount, 1, "the receipt fixture must observe exactly one accepted request");
                assert.equal(receiptSummaryForSample.acceptedResponseCount, 1, "the receipt fixture must observe exactly one successful mock ACK");
                assert.equal(receiptSummaryForSample.duplicatePairRequestCount, 0, "the clientMessageId pair must not be resubmitted");
                assert.equal(receiptSummaryForSample.acceptedIdentityFingerprints[0]?.clientMessageIdFingerprint, startIdentity.clientMessageIdFingerprint, "the accepted fixture must correlate the same stable clientMessageId");
                sampleResult.timingsMs.clickToAcceptedAck = round(ack.atMs - clickStartedAt);
                sampleResult.ack = { rpcIdFingerprint: ack.rpcIdFingerprint, routeSocketId: ack.routeSocketId, appliedDelayMs: responseDelay.appliedDelayMs, success: true };
                sampleResult.lifecycle = { turnIdFingerprint: started.turnIdFingerprint, completed: true, terminalVisibleAssistantReply: true };
                sampleResult.receiptFixture = receiptSummaryForSample;
                sampleResult.status = refreshDiagnosticMode ? "DIAGNOSTIC" : refreshSmokeMode ? "SMOKE" : "PASS";
              } else {
                if (delayMs > 0) {
                  const errorAlreadyForwarded = network.rpcEvents.some(item => item.direction === "response-forwarded"
                    && item.method === "turn/start"
                    && item.rpcIdFingerprint === request.rpcIdFingerprint
                    && item.stage === stage
                    && item.ok === false
                    && item.responseSource === "test-generated JSON-RPC error fixture");
                  assert.equal(errorAlreadyForwarded, false, "the delayed rejection response must remain outstanding while the local pending UI is observed");
                  assert.equal(
                    await pendingCard.getByText("正在发送，恢复记录已保存", { exact: true }).isVisible(),
                    true,
                    "the exact delayed turn/start error response must remain outstanding while the pending UI is visible",
                  );
                  sampleResult.pendingUiEvidence = {
                    status: "OBSERVED_WITH_EXACT_ERROR_RESPONSE_OUTSTANDING",
                    delayMs,
                    rpcIdFingerprint: request.rpcIdFingerprint,
                    routeSocketId: request.routeSocketId,
                  };
                }
                const errorResponse = await waitFor(
                  () => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage && item.ok === false && item.responseSource === "test-generated JSON-RPC error fixture"),
                  Math.max(10_000, delayMs + 5_000),
                  "request-id-correlated test error response delivered to the Mobile WebSocketMock",
                );
                sampleResult.timingsMs.clickToErrorResponse = round(errorResponse.atMs - clickStartedAt);
                const errorFixtureEvents = network.faultFixtureEvents.filter(item => item.scenario === row.scenario
                  && item.kind === "turn-start-error-fixture"
                  && item.requestIdFingerprint === request.rpcIdFingerprint
                  && item.stage === stage);
                assert.equal(errorFixtureEvents.length, 1, "exactly one typed rejection fixture must match this request id and stage");
                const [errorFixture] = errorFixtureEvents;
                assert.equal(errorFixture.requestIdPreserved, true, "the fixture error must preserve the exact JSON-RPC request id");
                assert.equal(errorFixture.requestIdFingerprint, request.rpcIdFingerprint, "the error fixture must preserve the exact request fingerprint");
                assert.equal(errorFixture.routeSocketId, request.routeSocketId, "the injected fixture must be bound to the request's originating route socket");
                assert.equal(errorFixture.clientMessageIdFingerprint, startIdentity.clientMessageIdFingerprint, "the injected rejection must correlate to the exact clientMessageId");
                const matchingErrorResponses = network.rpcEvents.filter(item => item.direction === "response-forwarded"
                  && item.method === "turn/start"
                  && item.rpcIdFingerprint === request.rpcIdFingerprint
                  && item.stage === stage
                  && item.ok === false
                  && item.responseSource === "test-generated JSON-RPC error fixture");
                assert.equal(matchingErrorResponses.length, 1, "exactly one request-id-correlated error response must be forwarded");
                const [uniqueErrorResponse] = matchingErrorResponses;
                assert.equal(uniqueErrorResponse.routeSocketId, request.routeSocketId, "the only matching error response must use the originating route socket");
                assert.equal(uniqueErrorResponse.rpcIdFingerprint, errorFixture.requestIdFingerprint, "the fixture and forwarded response must share the exact request fingerprint");
                assert.equal(errorResponse.routeSocketId, request.routeSocketId, "the request-id-correlated fixture response must return on the originating route socket");
                const responseDelay = network.websocketResponsePathDelays.find(item => item.method === "turn/start" && item.rpcIdFingerprint === request.rpcIdFingerprint && item.stage === stage);
                assertApplicationDelay(responseDelay, delayMs, "rejected turn/start fixture response hold");
                const failedCard = page.getByTestId("failed-submission").filter({ hasText: message });
                await failedCard.getByTestId("failed-submission-error").waitFor({ state: "visible", timeout: 10_000 });
                sampleResult.timingsMs.clickToFailedCardVisible = round(performance.now() - clickStartedAt);
                const failedContent = await failedCard.getByTestId("failed-submission-content").innerText();
                const failedError = await failedCard.getByTestId("failed-submission-error").innerText();
                assert.equal(sha256(failedContent.trim()), sha256(message), "the rejected client message must stay in its own failed-submission card");
                assert.ok(failedError.includes("Isolated Mobile E2E rejected this turn/start"), "the client UI must show the injected definite rejection");
                const startCountForStage = network.rpcEvents.filter(item => item.direction === "request" && item.method === "turn/start" && item.stage === stage).length;
                assert.equal(startCountForStage, 1, "the rejected sample must never automatically retry turn/start");

                const draft = `PHONE_UX_DRAFT_RETAINED_${delayMs}_${sampleId}`;
                await page.getByTestId("message-input").fill(draft);
                await waitFor(async () => page.evaluate(expected => Object.keys(localStorage).some(key => {
                  try { return JSON.parse(localStorage.getItem(key) || "null")?.composerDraft === expected; }
                  catch { return false; }
                }), draft), 5_000, "composer draft persistence before reload");
                sampleResult.draftFingerprint = sha256(draft).slice(0, 16);
                await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
                await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 60_000 });
                const reloadedCard = page.getByTestId("failed-submission").filter({ hasText: message });
                await reloadedCard.getByTestId("failed-submission-content").waitFor({ state: "visible", timeout: 15_000 });
                await reloadedCard.getByTestId("failed-submission-error").waitFor({ state: "visible", timeout: 15_000 });
                const restoredDraft = await page.getByTestId("message-input").inputValue();
                const restoredFailedContent = await reloadedCard.getByTestId("failed-submission-content").innerText();
                const restoredFailedError = await reloadedCard.getByTestId("failed-submission-error").innerText();
                assert.equal(sha256(restoredDraft), sha256(draft), "hard reload must restore the unsent composer draft from persisted workspace state");
                assert.equal(sha256(restoredFailedContent.trim()), sha256(message), "hard reload must restore the rejected message in the failed-submission card");
                assert.ok(restoredFailedError.includes("Isolated Mobile E2E rejected this turn/start"), "hard reload must restore the rejection detail in the failed-submission card");
                assert.equal(network.rpcEvents.filter(item => item.direction === "request" && item.method === "turn/start" && item.stage === stage).length, 1, "reload must not resend the failed clientMessageId");
                sampleResult.ack = { rpcIdFingerprint: errorResponse.rpcIdFingerprint, routeSocketId: errorResponse.routeSocketId, appliedDelayMs: responseDelay.appliedDelayMs, success: false, errorFixture: true };
                sampleResult.recoveryReadback = { failedSubmissionRestored: true, separateComposerDraftRestored: true, hardReload: true, automaticRetryCount: 0 };
                sampleResult.status = refreshDiagnosticMode ? "DIAGNOSTIC" : refreshSmokeMode ? "SMOKE" : "PASS";
              }
            }
          } catch (error) {
            sampleError = error;
            sampleResult.status = "FAIL";
            sampleResult.error = context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 700);
            if (page && !page.isClosed()) {
              sampleResult.pageAtFailure = await describeVisiblePage(page).catch(() => null);
              sampleResult.screenshot = await capturePrivateFailureScreenshot(context, page, `phone-ux-refresh-${group.id}-d${delayMs}-${sampleId}-failure.png`).catch(() => ({ artifact: null, status: "capture-failed" }));
            }
          } finally {
            const sampleFinishedAt = performance.now();
            sampleResult.setupElapsedMs = round((measurementStartedAt ?? sampleFinishedAt) - sampleLifecycleStartedAt);
            sampleResult.measurementElapsedMs = measurementStartedAt === null ? null : round(sampleFinishedAt - measurementStartedAt);
            sampleResult.elapsedMs = round(sampleFinishedAt - sampleLifecycleStartedAt);
            if (sampleAuth && page) {
              try {
                sampleResult.authLifecycle = await releaseOwnedMobileAuthSample(page, gateway, sampleAuth, context);
                if (sampleResult.authLifecycle.status === "PASS") formalAuthCleanupCount += 1;
                else {
                  sampleResult.status = "FAIL";
                  sampleError ??= new Error("formal per-sample mobile auth cleanup failed");
                }
              } catch (error) {
                sampleResult.authLifecycle = {
                  status: "FAIL",
                  failures: ["cleanup-helper-error"],
                  error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 400),
                };
                sampleResult.status = "FAIL";
                sampleError ??= error instanceof Error ? error : new Error(String(error));
              }
            }
            if (page) {
              try {
                if (group.kind === "background") await closeRefreshDiagnosticMobilePage(page);
                else await closeOwnedMobilePage(page).catch(() => {});
              } catch (error) {
                sampleResult.status = "FAIL";
                sampleResult.pageCleanupError = context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 500);
              }
            }
            if (ownsSampleChromium && sampleChromium) {
              try {
                await sampleChromium.close();
                sampleResult.backgroundBrowserCleanup = { status: "CLOSED", pid: sampleChromium.child.pid, cdpPort: sampleChromium.cdpPort };
              } catch (error) {
                sampleResult.status = "FAIL";
                sampleResult.backgroundBrowserCleanup = {
                  status: "FAILED",
                  pid: sampleChromium.child.pid,
                  cdpPort: sampleChromium.cdpPort,
                  error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 500),
                };
              }
            }
            sampleResults.push(sampleResult);
            if (sampleResult.status === "FAIL") totalFailedSamples += 1;
            await context.writeArtifactJson(`phone-ux-refresh-${group.id}-d${delayMs}-${sampleId}.json`, sampleResult);
            await progressWriter.write({
              schemaVersion: 1,
              scenario: row.scenario,
              status: totalFailedSamples ? "PARTIAL_FAIL" : "RUNNING",
              currentAction: group.id,
              currentDelayMs: delayMs,
              attemptedSamplesInCurrentBin: sampleResults.length,
              requiredSamplesPerBin: sampleCount,
              failedSamples: totalFailedSamples,
              completedGroups: groupResults,
              currentBin: sampleResults,
              delayBins: delayValues,
              actionIds: groups.map(item => item.id),
              noProviderConfigured: true,
              gatewayEvidenceClass: "KCODER_STUDIO_MOCK; JS runMock except the explicit test-generated error fixture",
            });
          }
          if (sampleResult.authLifecycle?.status === "FAIL") {
            throw new Error("formal auth cleanup failed; stop before another sample can inherit capacity state");
          }
          if (sampleError) continue;
        }
        const passed = sampleResults.filter(item => item.status === "PASS");
        const smoked = sampleResults.filter(item => item.status === "SMOKE");
        const diagnosticSamples = sampleResults.filter(item => item.status === "DIAGNOSTIC");
        const successfulSamples = [...passed, ...smoked, ...diagnosticSamples];
        const notRun = sampleResults.filter(item => item.status === "NOT_RUN");
        const failed = sampleResults.filter(item => item.status === "FAIL");
        const groupBin = {
          action: group.id,
          delayMs,
          requiredSamples: sampleCount,
          attemptedSamples: sampleResults.length,
          passedSamples: passed.length,
          smokeSamples: smoked.length,
          diagnosticSamples: diagnosticSamples.length,
          notRunSamples: notRun.length,
          failedSamples: failed.length,
          status: failed.length ? "FAIL"
            : refreshDiagnosticMode && diagnosticSamples.length === sampleCount ? "DIAGNOSTIC_ONLY"
              : refreshSmokeMode && smoked.length === sampleCount ? "SMOKE"
                : passed.length === sampleCount ? "PASS"
                  : passed.length === 0 && smoked.length === 0 && diagnosticSamples.length === 0 && notRun.length === sampleCount ? "NOT_RUN" : "PARTIAL",
          coverageMode: refreshCoverageMode,
          formalN30Coverage: !refreshSingleSampleMode,
          samples: sampleResults,
        };
        const percentileFields = refreshSingleSampleMode
          ? { percentileEligibility: refreshCoverageMode, percentilesReported: false }
          : {};
        if (group.kind === "accepted-send") {
          const pending = successfulSamples.map(item => item.timingsMs.clickToLocalPending).filter(Number.isFinite).sort((a, b) => a - b);
          const accepted = successfulSamples.map(item => item.timingsMs.clickToAcceptedAck).filter(Number.isFinite).sort((a, b) => a - b);
          if (refreshSingleSampleMode) Object.assign(groupBin, percentileFields, { clickToLocalPendingMs: pending[0] ?? null, clickToAcceptedAckMs: accepted[0] ?? null });
          else {
            groupBin.clickToLocalPendingP50P95Ms = { p50: percentile(pending, 0.5), p95: percentile(pending, 0.95) };
            groupBin.clickToAcceptedAckP50P95Ms = { p50: percentile(accepted, 0.5), p95: percentile(accepted, 0.95) };
          }
        }
        if (group.kind === "rejected-send") {
          const rejectionFrames = successfulSamples.map(item => item.timingsMs.clickToErrorResponse).filter(Number.isFinite).sort((a, b) => a - b);
          const failedCards = successfulSamples.map(item => item.timingsMs.clickToFailedCardVisible).filter(Number.isFinite).sort((a, b) => a - b);
          if (refreshSingleSampleMode) Object.assign(groupBin, percentileFields, { clickToErrorResponseMs: rejectionFrames[0] ?? null, clickToFailedCardVisibleMs: failedCards[0] ?? null });
          else {
            groupBin.clickToErrorResponseP50P95Ms = { p50: percentile(rejectionFrames, 0.5), p95: percentile(rejectionFrames, 0.95) };
            groupBin.clickToFailedCardVisibleP50P95Ms = { p50: percentile(failedCards, 0.5), p95: percentile(failedCards, 0.95) };
          }
        }
        if (group.kind === "background") {
          const activeToRequest = successfulSamples.map(item => item.refreshRequest?.activeToRequestMs).filter(Number.isFinite).sort((a, b) => a - b);
          if (refreshSingleSampleMode) Object.assign(groupBin, percentileFields, { activeToRefreshRequestMs: activeToRequest[0] ?? null });
          else groupBin.activeToRefreshRequestP50P95Ms = { p50: percentile(activeToRequest, 0.5), p95: percentile(activeToRequest, 0.95) };
          groupBin.completedResponseAppliedDelayMs = distribution(successfulSamples.map(item => item.response?.appliedDelayMs).filter(Number.isFinite));
        }
        delayResults.push(groupBin);
        await context.writeArtifactJson(`phone-ux-refresh-${group.id}-d${delayMs}-summary.json`, groupBin);
      }
      const groupStatus = refreshDiagnosticMode && delayResults.every(item => item.status === "DIAGNOSTIC_ONLY")
        ? "DIAGNOSTIC_ONLY"
        : refreshSmokeMode && delayResults.every(item => item.status === "SMOKE")
          ? "SMOKE"
        : delayResults.every(item => item.status === "PASS")
        ? "PASS"
        : delayResults.some(item => item.status === "FAIL")
          ? "FAIL"
          : delayResults.every(item => item.status === "NOT_RUN")
            ? "NOT_RUN"
            : "PARTIAL";
      const groupResult = {
        action: group.id,
        kind: group.kind,
        status: groupStatus,
        coverageMode: refreshCoverageMode,
        formalN30Coverage: !refreshSingleSampleMode,
        delayResults,
      };
      groupResults.push(groupResult);
      row.checks.groupResults = groupResults;
      await context.writeArtifactJson(`phone-ux-refresh-${group.id}-summary.json`, groupResult);
    }
    row.checks.pairing.freshBackgroundSamplePairings = backgroundSamplePairingCount;
    if (formalOwnedAuthLifecycle) {
      const finalAuthStore = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
      const expectedFormalSamples = groups.length * delayValues.length * sampleCount;
      row.checks.pairing.formalOwnedAuthLifecycle = {
        status: formalAuthSampleCount === expectedFormalSamples && formalAuthCleanupCount === expectedFormalSamples && finalAuthStore.active === 0 && formalMaxActiveDeviceGrants === 1 ? "PASS" : "FAIL",
        expectedSamples: expectedFormalSamples,
        observedSamplePairs: formalAuthSampleCount,
        exactGrantRevocationsAndWebLogouts: formalAuthCleanupCount,
        activeDeviceCountAtEnd: finalAuthStore.active,
        revokedDeviceRowsAtEnd: finalAuthStore.revoked,
        maxConcurrentActiveDeviceGrants: formalMaxActiveDeviceGrants,
      };
      assert.equal(row.checks.pairing.formalOwnedAuthLifecycle.status, "PASS", "every formal sample must own and release one fresh auth grant before the next sample");
    }
    row.checks.backgroundWindowLifecycle = refreshBackgroundWindowMode ? {
      hostStartupMs: refreshBackgroundHost?.setupElapsedMs ?? null,
      oneOwnedWindowHostPerRun: true,
      freshOwnedChromiumDefaultContextPerBackgroundSample: true,
      backgroundBrowserStartupRecordedSeparately: true,
      requestAndContentIntervalsExcludeBrowserStartupAndPairing: true,
      allBackgroundDelayBinsArmedAfterDrainedPreMinimizeBoundary: true,
    } : null;
    const allPass = groupResults.every(item => item.status === "PASS");
    const allSmoke = refreshSmokeMode && groupResults.every(item => item.status === "SMOKE");
    const allDiagnostic = refreshDiagnosticMode && groupResults.every(item => item.status === "DIAGNOSTIC_ONLY");
    const anyNotRun = groupResults.some(item => item.status === "NOT_RUN" || item.status === "PARTIAL");
    row.checks.coverageStatus = allPass ? "PASS" : allSmoke ? "SMOKE" : allDiagnostic ? "DIAGNOSTIC_ONLY" : totalFailedSamples ? "FAIL" : anyNotRun ? "PARTIAL" : "NOT_RUN";
    row.checks.coverageMode = refreshCoverageMode;
    row.checks.formalN30Coverage = !refreshSingleSampleMode;
    row.checks.diagnosticId = refreshSendDiagnosticMode ? refreshSendDiagnostic : refreshBackgroundDiagnosticMode ? refreshBackgroundDiagnostic : null;
    row.checks.requiredActions = groups.map(item => item.id);
    row.checks.requiredDelayBinsMs = delayValues;
    row.checks.samplesPerActionAndBin = sampleCount;
    row.checks.completedSequentially = true;
    row.checks.groupResults = groupResults;
    row.checks.delayBoundary = "one-way HTTP response or WSS JSON-RPC response hold in isolated loopback Gateway route; not RTT, packet loss, or radio latency";
    row.checks.draftDurabilityBoundary = "actual UI draft and failed-submission state are read back after hard reload from browser-persisted Mobile workspace state";
    row.checks.nativePlatform = "UNVERIFIED; Chromium Mobile Web only";
    await context.writeArtifactJson("phone-ux-refresh-send-progress-terminal.json", {
      schemaVersion: 1,
      artifactType: "terminal-aggregate",
      scenario: row.scenario,
      status: row.checks.coverageStatus,
      coverageMode: row.checks.coverageMode,
      formalN30Coverage: row.checks.formalN30Coverage,
      diagnosticId: refreshSendDiagnosticMode ? refreshSendDiagnostic : refreshBackgroundDiagnosticMode ? refreshBackgroundDiagnostic : null,
      lastProgressSequence: progressWriter.sequence,
      requiredSamplesPerBin: sampleCount,
      delayBins: delayValues,
      actionIds: groups.map(item => item.id),
      failedSamples: totalFailedSamples,
      completedGroups: groupResults,
      noProviderConfigured: true,
      gatewayEvidenceClass: "KCODER_STUDIO_MOCK; JS runMock except the explicit test-generated error fixture",
      nativePlatform: "UNVERIFIED; Chromium Mobile Web only",
    });
    await context.writeArtifactJson("phone-ux-refresh-send-summary.json", {
      schemaVersion: 1,
      scenario: row.scenario,
      status: row.checks.coverageStatus,
      coverageMode: row.checks.coverageMode,
      formalN30Coverage: row.checks.formalN30Coverage,
      evidenceClass: "real Mobile Web UI/TaskRuntime with isolated KCODER_STUDIO_MOCK; rejection is injected at the Playwright WebSocket route",
      noProviderConfigured: true,
      requiredActions: row.checks.requiredActions,
      requiredDelayBinsMs: row.checks.requiredDelayBinsMs,
      samplesPerActionAndBin: row.checks.samplesPerActionAndBin,
      smokeOnly: refreshSmokeMode,
      diagnosticOnly: refreshDiagnosticMode,
      diagnosticId: refreshSendDiagnosticMode ? refreshSendDiagnostic : refreshBackgroundDiagnosticMode ? refreshBackgroundDiagnostic : null,
      completedSequentially: true,
      groups: groupResults,
      failedSamples: totalFailedSamples,
      profileStorageState: "in-memory only; not serialized",
      nativePlatform: "UNVERIFIED",
    });
    if (totalFailedSamples) throw new Error(`${totalFailedSamples} refresh/send samples failed; inspect per-sample artifacts and preserve the original evidence`);
  }, { skipPageSetup: true });

  return { rows, requiredScenarioFailures, fixtureReceiptLedger: receiptSummary };
}

async function connectMobile(page, gateway, { beforeFixtureSessionVisible } = {}) {
  const loginResponse = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  page.__phoneUxLastNavigationStatus = loginResponse?.status() ?? null;
  assert.equal(loginResponse?.status(), 200, "isolated test Gateway should serve Mobile Web");
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 60_000 });
  if (beforeFixtureSessionVisible) await beforeFixtureSessionVisible();
  await ensureFixtureSessionVisible(page);
}

async function runFreshAuthCleanupUiGate(chromium, gateway, network, gatewayCalls, browserErrors, runContext, requiredCycles) {
  const rows = [];
  const browserContexts = new Set();
  const deviceFingerprints = new Set();
  let maximumActiveDeviceGrantsObserved = 0;

  for (let sampleNumber = 1; sampleNumber <= requiredCycles; sampleNumber += 1) {
    const sampleId = String(sampleNumber).padStart(2, "0");
    const stage = `auth-cleanup-ui-${sampleId}`;
    const row = {
      sampleNumber,
      status: "NOT_RUN",
      browserContextOrdinal: sampleNumber,
      pairResponseStatus: null,
      deviceFingerprint: null,
      activeDeviceCountBeforePair: null,
      activeDeviceCountAfterPair: null,
      activeDeviceCountAfterCleanup: null,
      browserContextClosed: false,
      browserErrors: 0,
      authLifecycle: null,
      error: null,
    };
    let page = null;
    let authCapture = null;
    const browserErrorStart = browserErrors.length;
    network.currentStage = stage;
    network.currentActionId = stage;

    try {
      const beforePair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
      row.activeDeviceCountBeforePair = beforePair.active;
      assert.equal(beforePair.active, 0, `sample ${sampleNumber} must start with no active device grants from the owned Gateway`);

      page = await newMobilePage(
        chromium,
        network,
        { delayMs: 0, scenarioId: refreshScenarioId },
        gatewayCalls,
        browserErrors,
        runContext,
      );
      const browserContext = page.context();
      assert.equal(browserContexts.has(browserContext), false, `sample ${sampleNumber} must use a new BrowserContext`);
      browserContexts.add(browserContext);

      authCapture = observeOwnedMobileAuth(page, runContext);
      await connectMobile(page, gateway);
      const pair = await authCapture.waitForPair();
      row.pairResponseStatus = pair.status;
      row.deviceFingerprint = pair.deviceFingerprint;
      assert.equal(deviceFingerprints.has(pair.deviceFingerprint), false, `sample ${sampleNumber} must receive a distinct device identity`);
      deviceFingerprints.add(pair.deviceFingerprint);

      const afterPair = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
      row.activeDeviceCountAfterPair = afterPair.active;
      maximumActiveDeviceGrantsObserved = Math.max(maximumActiveDeviceGrantsObserved, afterPair.active);
      assert.equal(afterPair.active, 1, `sample ${sampleNumber} must own exactly one active device grant after UI pairing`);
      await waitForGatewayRpcQuiescence(network, 15_000, 100);
      row.status = "PASS";
    } catch (error) {
      row.status = "FAIL";
      row.error = runContext.redactText(error instanceof Error ? error.message : String(error)).slice(0, 600);
    } finally {
      if (page && authCapture) {
        try {
          row.authLifecycle = await releaseOwnedMobileAuthSample(page, gateway, authCapture, runContext);
          if (row.authLifecycle.status !== "PASS") {
            row.status = "FAIL";
            row.error ??= "exact self-device revoke, web logout, stale-cookie rejection, or active-grant cleanup failed";
          }
        } catch (error) {
          row.status = "FAIL";
          row.error ??= runContext.redactText(error instanceof Error ? error.message : String(error)).slice(0, 600);
          row.authLifecycle = { status: "FAIL", failures: ["cleanup-helper-error"] };
          authCapture.dispose();
        }
      }

      if (page) {
        try {
          await closeOwnedMobilePage(page);
          row.browserContextClosed = page.isClosed();
          assert.equal(row.browserContextClosed, true, `sample ${sampleNumber} BrowserContext must be closed before the next sample`);
        } catch (error) {
          row.status = "FAIL";
          row.error ??= runContext.redactText(error instanceof Error ? error.message : String(error)).slice(0, 600);
        }
        try {
          await waitForGatewayRpcQuiescence(network, 15_000, 100);
        } catch (error) {
          row.status = "FAIL";
          row.error ??= runContext.redactText(error instanceof Error ? error.message : String(error)).slice(0, 600);
        }
      }

      try {
        const afterCleanup = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway));
        row.activeDeviceCountAfterCleanup = afterCleanup.active;
        if (afterCleanup.active !== 0) {
          row.status = "FAIL";
          row.error ??= `owned Gateway retained ${afterCleanup.active} active device grants after sample cleanup`;
        }
      } catch (error) {
        row.status = "FAIL";
        row.error ??= runContext.redactText(error instanceof Error ? error.message : String(error)).slice(0, 600);
      }

      row.browserErrors = browserErrors.length - browserErrorStart;
      if (row.browserErrors > 0) {
        row.status = "FAIL";
        row.error ??= "Mobile Web emitted a browser page error during the auth lifecycle gate";
      }
      await runContext.writeArtifactJson(`phone-ux-auth-cleanup-ui-gate-sample-${sampleId}.json`, row);
    }

    rows.push(row);
    if (row.status !== "PASS") break;
  }

  let finalDeviceSummary = null;
  try { finalDeviceSummary = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway)); }
  catch {}
  const passedCycles = rows.filter(row => row.status === "PASS").length;
  const status = rows.length === requiredCycles
    && passedCycles === requiredCycles
    && browserContexts.size === requiredCycles
    && deviceFingerprints.size === requiredCycles
    && finalDeviceSummary?.active === 0
    && maximumActiveDeviceGrantsObserved === 1
    ? "PASS"
    : "FAIL";
  return {
    status,
    requiredCycles,
    attemptedCycles: rows.length,
    passedCycles,
    notRunCycles: requiredCycles - rows.length,
    distinctBrowserContexts: browserContexts.size,
    distinctDeviceFingerprints: deviceFingerprints.size,
    maximumActiveDeviceGrantsObserved,
    activeDeviceCountAfterAll: finalDeviceSummary?.active ?? null,
    rows,
  };
}


function observeOwnedMobileAuth(page, runContext) {
  let resolveObservation;
  const observed = new Promise(resolveObserved => { resolveObservation = resolveObserved; });
  let pair = null;
  let settled = false;
  const onResponse = response => {
    if (settled || response.request().method() !== "POST" || safePath(response.url()) !== "/api/mobile/session") return;
    void (async () => {
      let payload = null;
      try { payload = await response.json(); } catch {}
      pair = {
        status: response.status(),
        accessToken: typeof payload?.accessToken === "string" ? payload.accessToken : null,
        deviceId: typeof payload?.deviceId === "string" ? payload.deviceId : null,
        mobileRefreshV1: payload?.capabilities?.mobileRefreshV1 === true,
      };
      if (pair.accessToken) runContext.registerSecret(pair.accessToken);
      settled = true;
      resolveObservation(pair);
    })();
  };
  page.on("response", onResponse);
  return {
    getPair: () => pair,
    async waitForObservation(timeoutMs = 1_500) {
      let timer;
      try {
        return await Promise.race([
          observed,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned mobile pair response was not observed")), timeoutMs); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async waitForPair(timeoutMs = 5_000) {
      const result = await this.waitForObservation(timeoutMs);
      assert.equal(result.status, 200, "fresh UI pair must return HTTP 200");
      assert.ok(result.accessToken && result.deviceId, "fresh UI pair must return an access token and device identity");
      assert.equal(result.mobileRefreshV1, true, "fresh UI pair must create a durable device grant");
      return { status: result.status, deviceFingerprint: sha256(result.deviceId).slice(0, 16), mobileRefreshV1: result.mobileRefreshV1 };
    },
    dispose() { page.off("response", onResponse); },
  };
}

function ownedMobileDeviceStorePath(gateway) {
  return resolve(gateway.serversStore, "..", "mobile-device-auth", "devices.json");
}

async function readOwnedMobileDeviceSummary(path) {
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return { active: 0, revoked: 0, stored: 0 };
    throw error;
  }
  const store = JSON.parse(raw);
  assert.equal(store?.version, 1, "owned Gateway device store format changed");
  assert.ok(Array.isArray(store.devices), "owned Gateway device store must contain a devices array");
  const now = Date.now();
  return {
    active: store.devices.filter(device => device && device.revoked !== true
      && Number.isSafeInteger(device.expiresAt) && device.expiresAt > now
      && Number.isSafeInteger(device.absoluteExpiresAt) && device.absoluteExpiresAt > now).length,
    revoked: store.devices.filter(device => device?.revoked === true).length,
    stored: store.devices.length,
  };
}

async function releaseOwnedMobileAuthSample(page, gateway, capture, runContext) {
  let pair = capture.getPair();
  if (!pair) pair = await capture.waitForObservation(750).catch(() => null);
  const failures = [];
  let revokeStatus = "not-attempted";
  if (pair?.accessToken) {
    try {
      const response = await fetch(`${gateway.baseUrl}/api/mobile/session`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${pair.accessToken}`, accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      revokeStatus = response.status;
    } catch { revokeStatus = "request-failed"; }
  }
  if (!pair || pair.status !== 200 || !pair.accessToken || !pair.deviceId || pair.mobileRefreshV1 !== true) failures.push("pair-response-invalid-or-missing");
  if (revokeStatus !== 204) failures.push("exact-device-revoke-not-204");

  let cookieHeader = null;
  try {
    const cookie = (await page.context().cookies(gateway.baseUrl)).find(item => item.name === "kcoder_studio_session");
    if (cookie?.value) {
      cookieHeader = `kcoder_studio_session=${cookie.value}`;
      runContext.registerSecret(cookieHeader);
    }
  } catch {}
  let logoutStatus = "not-attempted";
  let staleSessionHttpStatus = "not-attempted";
  if (cookieHeader) {
    try {
      const response = await fetch(`${gateway.baseUrl}/logout`, {
        method: "POST",
        headers: { cookie: cookieHeader, accept: "text/html" },
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      logoutStatus = response.status;
    } catch { logoutStatus = "request-failed"; }
    try {
      const response = await fetch(`${gateway.baseUrl}/api/servers`, {
        headers: { cookie: cookieHeader, accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      staleSessionHttpStatus = response.status;
    } catch { staleSessionHttpStatus = "request-failed"; }
  } else {
    failures.push("owned-web-cookie-missing");
  }
  if (logoutStatus !== 303) failures.push("web-session-logout-not-303");
  if (staleSessionHttpStatus !== 401) failures.push("logged-out-cookie-not-rejected");

  let deviceStore = null;
  try { deviceStore = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway)); }
  catch { failures.push("owned-device-store-unreadable"); }
  if (deviceStore && deviceStore.active !== 0) failures.push("active-owned-device-remained");
  capture.dispose();
  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    pairResponseStatus: pair?.status ?? "not-observed",
    deviceFingerprint: pair?.deviceId ? sha256(pair.deviceId).slice(0, 16) : null,
    durableGrantObserved: pair?.mobileRefreshV1 === true,
    revokeStatus,
    logoutStatus,
    staleSessionHttpStatus,
    activeDeviceCountAfter: deviceStore?.active ?? null,
    revokedDeviceRowsAfter: deviceStore?.revoked ?? null,
    failures,
  };
}

async function newMobilePage(chromium, network, delayControl, gatewayCalls, browserErrors, context, storageState, options = {}) {
  const ownsBrowserContext = !options.browserContext;
  const browserContext = options.browserContext ?? await chromium.browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
    ...(storageState ? { storageState } : {}),
  });
  let page;
  try {
    page = await browserContext.newPage();
    const pageId = ++network.applicationPageSequence;
    observeOwnedMobilePage(page, {
      runContext: context,
      pageId,
      onPageError: error => browserErrors.push(context.redactText(error.message).slice(0, 500)),
      onRequestFailed: request => {
        const pathname = safePath(request.url());
        network.failedRequests[pathname] = (network.failedRequests[pathname] ?? 0) + 1;
      },
    });
    if (options.prepareViewportDocument) {
      await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>', {
        waitUntil: "load",
        timeout: 5_000,
      });
    }
    if (options.applyMobileEmulation) await applyRefreshBackgroundMobileEmulation(page, { storeForPage: true });
    await installPageInstrumentation(page, pageId);
    await installNetworkInstrumentation(page, pageId, network, delayControl, gatewayCalls);
    return page;
  } catch (error) {
    if (page) {
      if (options.applyMobileEmulation) {
        try { await closeRefreshDiagnosticMobilePage(page, { closeContext: ownsBrowserContext }); } catch {}
      } else {
        await closeOwnedMobilePage(page, { closeContext: ownsBrowserContext || options.closeContextOnError !== false }).catch(() => {});
      }
    } else if (ownsBrowserContext || options.closeContextOnError !== false) await browserContext.close().catch(() => {});
    throw error;
  }
}

async function startRefreshBackgroundChromium(context, { host: suppliedHost = null, instanceKey = "diagnostic", hostOnly = false } = {}) {
  assert.match(instanceKey, /^[a-z0-9][a-z0-9-]{0,100}$/, "owned background Chromium instance key must be a safe lowercase slug");
  let host = suppliedHost ?? REFRESH_BACKGROUND_WINDOW_HOSTS.get(context);
  if (!host) {
    const hostSetupStartedAt = performance.now();
    assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, "1", "owned-window background samples require the explicit KCODER_E2E_CHROMIUM_NO_SANDBOX=1 setting");
    assert.equal(process.version, "v22.17.0", "owned-window background samples require the pinned Node 22.17.0 runtime");
    const nodeRealpath = await realpath(process.execPath);
    assert.equal(nodeRealpath, REFRESH_R7_NODE_REALPATH, "owned-window sample Node executable differs from the R7-pinned runtime");
    assert.equal(sha256(await readFile(nodeRealpath)), REFRESH_R7_NODE_SHA256, "owned-window sample Node runtime SHA changed");
    const chromiumRealpath = await realpath(REFRESH_R7_CHROMIUM_PATH);
    assert.equal(chromiumRealpath, REFRESH_R7_CHROMIUM_REALPATH, "owned-window sample Chromium executable resolved to an unexpected path");
    assert.equal(sha256(await readFile(chromiumRealpath)), REFRESH_R7_CHROMIUM_SHA256, "owned-window sample Chromium SHA changed");
    const xvfbRealpath = await realpath(REFRESH_R7_XVFB_PATH);
    assert.equal(xvfbRealpath, REFRESH_R7_XVFB_PATH, "owned-window sample Xvfb path changed");
    assert.equal(sha256(await readFile(xvfbRealpath)), REFRESH_R7_XVFB_SHA256, "owned-window sample Xvfb SHA changed");
    const openboxRealpath = await realpath(REFRESH_R7_OPENBOX_PATH);
    assert.equal(openboxRealpath, REFRESH_R7_OPENBOX_PATH, "owned-window sample private Openbox path changed");
    assert.equal(sha256(await readFile(openboxRealpath)), REFRESH_R7_OPENBOX_SHA256, "owned-window sample private Openbox SHA changed");
    const openboxRcBytes = await readFile(REFRESH_R7_OPENBOX_RC_PATH);
    assert.equal(sha256(openboxRcBytes), REFRESH_R7_OPENBOX_RC_SHA256, "owned-window sample Openbox config input SHA changed");
    const playwrightEntry = await lstat(REFRESH_R7_PLAYWRIGHT_TEST_ENTRY);
    assert.ok(playwrightEntry.isFile() && !playwrightEntry.isSymbolicLink(), "owned-window sample Playwright test entry must be a regular pinned file");
    assert.equal(sha256(await readFile(REFRESH_R7_PLAYWRIGHT_TEST_ENTRY)), REFRESH_R7_PLAYWRIGHT_TEST_ENTRY_SHA256, "owned-window sample Playwright test entry SHA changed");
    const playwrightCorePackage = JSON.parse(await readFile(REFRESH_R7_PLAYWRIGHT_CORE_PACKAGE, "utf8"));
    assert.equal(playwrightCorePackage.version, "1.62.0", "owned-window sample requires the R7-pinned Playwright Core version");
    assert.equal(sha256(await readFile(REFRESH_R7_PLAYWRIGHT_CORE_PACKAGE)), REFRESH_R7_PLAYWRIGHT_CORE_PACKAGE_SHA256, "owned-window sample Playwright Core package SHA changed");
    const diagnosticHelperInfo = await lstat(REFRESH_BACKGROUND_HOOK_HELPER_PATH);
    assert.ok(diagnosticHelperInfo.isFile() && !diagnosticHelperInfo.isSymbolicLink(), "test-only before-minimize hook helper must be a regular file");
    assert.equal(await realpath(REFRESH_BACKGROUND_HOOK_HELPER_PATH), REFRESH_BACKGROUND_HOOK_HELPER_PATH, "test-only before-minimize hook helper must not traverse a symlink");
    assert.equal(sha256(await readFile(REFRESH_BACKGROUND_HOOK_HELPER_PATH)), REFRESH_BACKGROUND_HOOK_HELPER_SHA256, "test-only before-minimize hook helper SHA changed");
    const visibilityHelper = await import(pathToFileURL(REFRESH_BACKGROUND_HOOK_HELPER_PATH).href);
    assert.equal(typeof visibilityHelper.captureWindowMinimizeVisibilityCycle, "function", "test-only before-minimize hook helper must export the real window visibility driver");

    const display = await startOwnedDisplay(context);
    const openboxHome = context.pathInState("refresh-background-openbox-home");
    const openboxConfigHome = resolve(openboxHome, ".config");
    const openboxConfigDirectory = resolve(openboxConfigHome, "openbox");
    const openboxDataHome = resolve(openboxHome, ".local/share");
    const openboxCacheHome = resolve(openboxHome, ".cache");
    const openboxRuntimeHome = context.pathInState("refresh-background-openbox-runtime");
    const openboxTempHome = context.pathInState("refresh-background-openbox-tmp");
    for (const directory of [openboxHome, openboxConfigHome, openboxConfigDirectory, openboxDataHome, openboxCacheHome, openboxRuntimeHome, openboxTempHome]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o777) === 0o700, "owned Openbox directories must stay private and task-owned");
    }
    const openboxConfig = resolve(openboxConfigDirectory, "rc.xml");
    await writeFile(openboxConfig, openboxRcBytes, { flag: "wx", mode: 0o600 });
    const openboxMenu = resolve(openboxConfigDirectory, "menu.xml");
    await writeFile(openboxMenu, '<?xml version="1.0" encoding="UTF-8"?><openbox_menu xmlns="http://openbox.org/"><menu id="root-menu" label="Private Mobile visibility diagnostic"><item label="Exit"><action name="Exit"/></item></menu></openbox_menu>', { flag: "wx", mode: 0o600 });
    const wmEnvironment = context.isolatedEnvironment({
      DISPLAY: display.display,
      XAUTHORITY: display.authority,
      HOME: openboxHome,
      PATH: "/usr/bin:/bin",
      TMP: openboxTempHome,
      TMPDIR: openboxTempHome,
      XDG_CONFIG_HOME: openboxConfigHome,
      XDG_CONFIG_DIRS: resolve(REFRESH_R7_INPUT_ROOT, "prefix/etc/xdg"),
      XDG_DATA_HOME: openboxDataHome,
      XDG_DATA_DIRS: resolve(REFRESH_R7_INPUT_ROOT, "prefix/usr/share"),
      XDG_CACHE_HOME: openboxCacheHome,
      XDG_RUNTIME_DIR: openboxRuntimeHome,
      LD_LIBRARY_PATH: REFRESH_R7_OPENBOX_LIB_DIR,
      IMLIB2_LOADER_PATH: REFRESH_R7_OPENBOX_LOADER_DIR,
      IMLIB2_FILTER_PATH: REFRESH_R7_OPENBOX_FILTER_DIR,
    });
    const openbox = context.spawnOwned("phone-ux-background-openbox", REFRESH_R7_OPENBOX_PATH, ["--sm-disable", "--config-file", openboxConfig], { env: wmEnvironment });
    await waitFor(() => {
      if (openbox.exitCode !== null) throw new Error("owned Openbox exited before the Mobile visibility sample");
      return true;
    }, 2_000, "owned Mobile Openbox process start", 50, context.abortSignal);
    await new Promise(resolveWait => setTimeout(resolveWait, 400));
    assert.equal(openbox.exitCode, null, "owned Openbox exited during startup");

    host = {
      nodeRealpath,
      chromiumRealpath,
      xvfbRealpath,
      openboxRealpath,
      playwrightCorePackage,
      display,
      openbox,
      visibilityHelper,
      setupElapsedMs: round(performance.now() - hostSetupStartedAt),
    };
    REFRESH_BACKGROUND_WINDOW_HOSTS.set(context, host);
    await context.writeArtifactJson("phone-ux-background-window-host-runtime.json", {
      schemaVersion: 1,
      node: { path: nodeRealpath, version: process.version, sha256: REFRESH_R7_NODE_SHA256 },
      playwright: { version: playwrightCorePackage.version, testEntrySha256: REFRESH_R7_PLAYWRIGHT_TEST_ENTRY_SHA256, corePackageSha256: REFRESH_R7_PLAYWRIGHT_CORE_PACKAGE_SHA256 },
      xvfb: { path: xvfbRealpath, sha256: REFRESH_R7_XVFB_SHA256, pid: display.child.pid, display: display.display },
      openbox: { path: openboxRealpath, sha256: REFRESH_R7_OPENBOX_SHA256, pid: openbox.pid, privateConfigSha256: REFRESH_R7_OPENBOX_RC_SHA256 },
      hostSetupElapsedMs: host.setupElapsedMs,
      visibilityHelper: {
        basePath: relative(repoRoot, REFRESH_BACKGROUND_HOOK_HELPER_PATH),
        baseSha256: REFRESH_BACKGROUND_HOOK_HELPER_SHA256,
        activeTestPath: relative(repoRoot, REFRESH_BACKGROUND_HOOK_HELPER_PATH),
        activeTestSha256: REFRESH_BACKGROUND_HOOK_HELPER_SHA256,
        testOnlyHook: "await pre-minimize quiescence and HTTP hold arming after main page foreground/visible check, before minimize boundary",
      },
      mobileMetrics: REFRESH_R7_MOBILE_METRICS,
      touchEmulation: REFRESH_R7_TOUCH,
      noGlobalPackageInstall: true,
    });
  }
  if (hostOnly) return host;

  const label = `phone-ux-background-window-chromium-${instanceKey}`;
  const profileDir = context.pathInState("chromium", `${label}-profile`);
  context.registerTemporaryDirectory(`${label} profile`, profileDir);
  const args = [
    "--no-sandbox", "--disable-setuid-sandbox",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows", "--disable-component-update",
    "--disable-renderer-backgrounding", "--disable-sync", "--metrics-recording-only", "about:blank",
  ];
  const chromiumStartedAt = performance.now();
  const child = context.spawnOwned(label, REFRESH_R7_CHROMIUM_PATH, args, {
    env: context.isolatedEnvironment({ DISPLAY: host.display.display, XAUTHORITY: host.display.authority }, []),
  });
  let browser = null;
  let close = null;
  try {
    const activePortFile = resolve(profileDir, "DevToolsActivePort");
    const activePort = await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`owned Chromium exited before CDP became ready with code ${child.exitCode}`);
      const raw = await readFile(activePortFile, "utf8").catch(() => "");
      const [portText, webSocketPath] = raw.trim().split(/\r?\n/);
      const port = Number(portText);
      return Number.isInteger(port) && port > 0 && webSocketPath?.startsWith("/devtools/browser/") ? { port } : null;
    }, 20_000, "owned Mobile Chromium CDP endpoint", 50, context.abortSignal);
    const portLabel = `${label}-cdp`;
    context.registerPort(portLabel, activePort.port);
    browser = await playwrightChromium.connectOverCDP(`http://127.0.0.1:${activePort.port}`, { noDefaults: true });
    const startupElapsedMs = round(performance.now() - chromiumStartedAt);
    let closed = false;
    close = async () => {
      if (closed) return;
      closed = true;
      try { await browser.close(); } finally { await context.stopOwned(label); }
    };
    context.addCleanup(`close Mobile noDefaults Chromium CDP client ${instanceKey}`, close);
    assert.equal(browser.isConnected(), true, "first and only noDefaults CDP connection must remain connected");
    const contexts = browser.contexts();
    assert.equal(contexts.length, 1, "first noDefaults CDP attach must expose exactly one default BrowserContext");
    const result = {
      browser,
      child,
      cdpPort: activePort.port,
      executablePath: REFRESH_R7_CHROMIUM_PATH,
      display: host.display.display,
      xauthority: host.display.authority,
      openboxPid: host.openbox.pid,
      profileDir,
      noDefaults: true,
      connectOverCDPCallCount: 1,
      defaultContext: contexts[0],
      startupElapsedMs,
      visibilityHelper: host.visibilityHelper,
      close,
    };
    await context.writeArtifactJson(`phone-ux-background-window-runtime-${instanceKey}.json`, {
      schemaVersion: 1,
      evidenceClass: "test-only real Mobile Web UI through isolated KCODER_STUDIO_MOCK Gateway; no Provider/model",
      instanceKey,
      chromium: { path: host.chromiumRealpath, sha256: REFRESH_R7_CHROMIUM_SHA256, pid: child.pid, cdpPort: activePort.port, firstAndOnlyNoDefaultsAttach: true, defaultBrowserContextCount: 1, portLabel },
      chromiumStartupElapsedMs: startupElapsedMs,
      visibilityHelper: {
        basePath: relative(repoRoot, REFRESH_BACKGROUND_HOOK_HELPER_PATH),
        baseSha256: REFRESH_BACKGROUND_HOOK_HELPER_SHA256,
        activeTestPath: relative(repoRoot, REFRESH_BACKGROUND_HOOK_HELPER_PATH),
        activeTestSha256: REFRESH_BACKGROUND_HOOK_HELPER_SHA256,
        testOnlyHook: "await pre-minimize quiescence and HTTP hold arming after main page foreground/visible check, before minimize boundary",
      },
    });
    return result;
  } catch (error) {
    const cleanupErrors = [];
    if (close) await close().catch(cleanupError => cleanupErrors.push(cleanupError));
    else await context.stopOwned(label).catch(cleanupError => cleanupErrors.push(cleanupError));
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], `owned background Chromium ${instanceKey} failed to start or initialize and cleanup was incomplete`);
    throw error;
  }
}

async function requireOwnedDefaultBrowserContext(browser) {
  assert.equal(browser.isConnected(), true, "owned Chromium CDP client must be connected");
  const contexts = browser.contexts();
  assert.equal(contexts.length, 1, "noDefaults browser attach must expose exactly one BrowserContext");
  return contexts[0];
}

async function applyRefreshBackgroundMobileEmulation(page, { storeForPage = false } = {}) {
  const session = await page.context().newCDPSession(page);
  const record = { session, detached: false, facts: null, gate: false };
  try {
    await session.send("Emulation.setDeviceMetricsOverride", REFRESH_R7_MOBILE_METRICS);
    await session.send("Emulation.setTouchEmulationEnabled", REFRESH_R7_TOUCH);
    record.facts = await readRefreshBackgroundMobileFacts(page);
    record.gate = refreshBackgroundMobileFactsMatch(record.facts);
    assert.equal(record.gate, true, "real CDP metrics must produce a 390x844 DPR1 mobile/touch viewport");
    if (storeForPage) REFRESH_BACKGROUND_MOBILE_SESSIONS.set(page, record);
    return record;
  } catch (error) {
    try { await session.detach(); record.detached = true; } catch {}
    throw error;
  }
}

async function readRefreshBackgroundMobileFacts(page) {
  return page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio,
    maxTouchPoints: navigator.maxTouchPoints,
    coarsePointer: matchMedia("(pointer: coarse)").matches,
    visibilityState: document.visibilityState,
  }));
}

function refreshBackgroundMobileFactsMatch(facts) {
  return facts?.width === 390 && facts?.height === 844 && facts?.devicePixelRatio === 1 && facts.maxTouchPoints >= 1 && facts.coarsePointer === true;
}

async function closeRefreshDiagnosticMobilePage(page, { closeContext = false } = {}) {
  const record = REFRESH_BACKGROUND_MOBILE_SESSIONS.get(page);
  let failure = null;
  if (record && !record.detached) {
    try {
      await record.session.detach();
      record.detached = true;
      REFRESH_BACKGROUND_MOBILE_SESSIONS.delete(page);
    } catch (error) {
      failure = error;
    }
  }
  try { await closeOwnedMobilePage(page, { closeContext }); } catch (error) { failure ??= error; }
  if (failure) throw failure;
}

async function collectPreShimNativeWebSocketEvidence(page, network) {
  const evidence = await page.evaluate(() => window.__phoneUxDrainApplicationWebSocketEvidence?.() ?? null);
  if (!evidence) return null;
  network.applicationWebSocketCaptureHealth.push({
    captureLayer: "pre-playwright-WebSocketMock native transport; upstream observation only, not app dispatch/receipt",
    pageId: evidence.pageId,
    socketsCapturedThisDrain: evidence.sockets.length,
    framesCapturedThisDrain: evidence.frames.length,
    socketOverflowCount: evidence.socketOverflowCount,
    frameOverflowCount: evidence.frameOverflowCount,
    storageWriteFailureCount: evidence.storageWriteFailureCount,
    maxSocketsPerPage: evidence.maxSocketsPerPage,
    maxFramesPerPage: evidence.maxFramesPerPage,
    drainedAtEpochMs: round(epochNow()),
  });
  const socketKeys = new Set(network.applicationWebSocketConnections.map(row => `${row.pageId}:${row.socketId}`));
  for (const row of evidence.sockets) {
    const key = `${row.pageId}:${row.socketId}`;
    if (!socketKeys.has(key)) {
      network.applicationWebSocketConnections.push(row);
      socketKeys.add(key);
    }
  }
  const frameKeys = new Set(network.applicationWebSocketFrames.map(row => `${row.pageId}:${row.socketId}:${row.direction}:${row.atEpochMs}:${row.rpcIdFingerprint ?? "-"}:${row.method ?? "-"}`));
  for (const row of evidence.frames) {
    const key = `${row.pageId}:${row.socketId}:${row.direction}:${row.atEpochMs}:${row.rpcIdFingerprint ?? "-"}:${row.method ?? "-"}`;
    if (!frameKeys.has(key)) {
      network.applicationWebSocketFrames.push(row);
      frameKeys.add(key);
    }
  }
  return { pageId: evidence.pageId, socketsCapturedThisDrain: evidence.sockets.length, framesCapturedThisDrain: evidence.frames.length };
}

async function ensureFixtureSessionVisible(page) {
  const thread = page.getByTestId(`thread-${THREAD_ID}`);
  if (await thread.isVisible().catch(() => false)) return;
  const serverToggle = page.getByTestId(`toggle-server-${SERVER_ID}`);
  await serverToggle.waitFor({ state: "visible", timeout: 30_000 });
  if ((await serverToggle.getAttribute("aria-expanded")) !== "true") await serverToggle.click();
  await thread.waitFor({ state: "visible", timeout: 30_000 });
}

async function describeVisiblePage(page) {
  const urlPath = safePath(page.url());
  const routeClass = await page.evaluate(() => {
    const path = globalThis.location?.pathname ?? "";
    if (path.startsWith("/welcome")) return "welcome";
    if (path.includes("/task/")) return "task";
    if (path.startsWith("/settings")) return "settings";
    if (path === "/" || path.includes("/h/")) return "home";
    return "other";
  }).catch(() => "unavailable");
  const visible = {};
  for (const [name, selector] of Object.entries({
    welcomeDirectConnection: "welcome-direct-connection",
    welcomePairingLink: "welcome-paste-pairing-link",
    newWorkspace: "new-workspace",
    serverStatusRefreshing: "server-status-refreshing",
    serverStatusError: "server-status-error",
    reauthorizeActiveProfile: "reauthorize-active-profile",
    fixtureServerToggle: `toggle-server-${SERVER_ID}`,
    fixtureThread: `thread-${THREAD_ID}`,
    taskHeader: "task-header-title",
    messageInput: "message-input-root",
  })) visible[name] = await page.getByTestId(selector).isVisible().catch(() => false);
  visible.gatewayLoginToken = await page.locator('input[name="token"]').isVisible().catch(() => false);
  visible.gatewayLoginSubmit = await page.locator('form[action="/login"] button[type="submit"]').isVisible().catch(() => false);
  visible.gatewayEndpoint = await page.getByTestId("gateway-endpoint").isVisible().catch(() => false);
  visible.gatewayToken = await page.getByTestId("gateway-token").isVisible().catch(() => false);
  visible.gatewayConnect = await page.getByTestId("gateway-connect").isVisible().catch(() => false);
  return {
    urlPath,
    lastNavigationStatus: Number.isInteger(page.__phoneUxLastNavigationStatus) ? page.__phoneUxLastNavigationStatus : null,
    routeClass,
    visible,
  };
}

function observeLoginResponses(page, output, stage, sampleId) {
  const listener = response => {
    if (safePath(response.url()) !== "/login") return;
    output.push({
      path: "/login",
      method: response.request().method(),
      status: response.status(),
      stage,
      sampleId,
    });
  };
  page.on("response", listener);
  return () => page.off("response", listener);
}

async function capturePrivateFailureScreenshot(context, page, artifactName) {
  try {
    await page.evaluate(() => {
      const sensitive = document.querySelectorAll(
        'input[type="password"], input[name*="token" i], input[id*="token" i], [data-testid*="token" i]',
      );
      for (const element of sensitive) {
        if (element instanceof HTMLInputElement) {
          element.value = "";
          element.setAttribute("value", "");
        }
        element.style.visibility = "hidden";
      }
    });
    const screenshotPath = context.pathInArtifacts(artifactName);
    await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled", timeout: 5_000 });
    await chmod(screenshotPath, 0o600);
    const screenshotStat = await stat(screenshotPath);
    const mode = screenshotStat.mode & 0o777;
    assert.equal(mode, 0o600, "failure screenshot must be private to the run owner");
    return {
      artifact: artifactName,
      status: "captured",
      mode: mode.toString(8).padStart(4, "0"),
      credentialInputsMasked: true,
    };
  } catch (error) {
    return {
      artifact: null,
      status: "capture-failed",
      error: context.redactText(String(error instanceof Error ? error.message : error)).slice(0, 300),
    };
  }
}

function summarizeHttpDelaySample(sample) {
  return {
    path: sanitizeGatewayPath(sample.apiPath ?? sample.path),
    status: sample.status,
    configuredDelayMs: sample.configuredDelayMs,
    jitterDelayMs: sample.jitterDelayMs,
    appliedDelayMs: sample.appliedDelayMs,
    stage: sample.stage,
  };
}

function summarizeWebSocketDelaySample(sample) {
  return {
    path: sanitizeGatewayPath(sample.path),
    method: sample.method,
    routeSocketId: sample.routeSocketId,
    configuredDelayMs: sample.configuredDelayMs,
    jitterDelayMs: sample.jitterDelayMs,
    appliedDelayMs: sample.appliedDelayMs,
    stage: sample.stage,
  };
}

async function openFixtureSession(page) {
  await ensureFixtureSessionVisible(page);
  await page.getByTestId(`thread-${THREAD_ID}`).click();
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 60_000 });
}

async function assertRunningControlsStayHiddenAfterTwoFrames(page, description) {
  const stopButton = page.getByTestId("stop-turn");
  const stopStatus = page.getByTestId("stop-turn-status");
  await stopButton.waitFor({ state: "hidden", timeout: 5_000 });
  await stopStatus.waitFor({ state: "hidden", timeout: 5_000 });
  const twoFramesObserved = await page.evaluate(() => new Promise(resolve => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, 3_000);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(true);
    }));
  }));
  assert.equal(twoFramesObserved, true, `${description}: the browser did not deliver two animation frames`);
  await stopButton.waitFor({ state: "hidden", timeout: 1_000 });
  await stopStatus.waitFor({ state: "hidden", timeout: 1_000 });
}

async function measureClick(page, output, spec, context, network) {
  const id = `ux-${Math.random().toString(36).slice(2)}`;
  const urlBefore = page.url();
  const targetMeasures = [{ id, action: spec.action, targetSelector: spec.targetSelector, targetVisible: spec.targetVisible, targetText: spec.targetText },
    ...(spec.additionalTargets || []).map(target => ({
      id: `ux-${Math.random().toString(36).slice(2)}`,
      action: target.action,
      targetSelector: target.targetSelector,
      targetVisible: target.targetVisible,
      requireTargetTransition: target.requireTargetTransition ?? false,
      targetText: target.targetText,
    }))];
  await page.evaluate(values => values.forEach(value => window.__phoneUxArm(value)), targetMeasures.map(value => ({
    id: value.id,
    action: value.action,
    sourceSelector: spec.sourceSelector,
    targetSelector: value.targetSelector,
    targetVisible: value.targetVisible,
    requireTargetTransition: value.requireTargetTransition ?? false,
    targetText: value.targetText,
  })));
  const nodeStart = performance.now();
  const nodeStartEpochMs = epochNow();
  network.currentActionId = id;
  network.currentAction = spec.action;
  let error = null;
  try {
    await spec.click();
    await spec.wait();
  } catch (caught) {
    error = caught;
  }
  const browserMeasures = new Map();
  for (const target of targetMeasures) {
    const measure = await page.waitForFunction(measureId => window.__phoneUxMeasure(measureId), target.id, { timeout: 15_000 })
      .then(handle => handle.jsonValue())
      .catch(() => null);
    browserMeasures.set(target.id, measure);
  }
  const browserMeasure = browserMeasures.get(id);
  output.push({
    action: spec.action,
    actionId: id,
    cacheClass: spec.cacheClass,
    delayMs: spec.delayMs,
    durationMs: browserMeasure?.paintFeedbackMs ?? round(performance.now() - nodeStart),
    domReadyMs: browserMeasure?.domReadyMs ?? null,
    paintFeedbackMs: browserMeasure?.paintFeedbackMs ?? null,
    nodeClickStartedAtMs: round(nodeStart),
    nodeClickStartedAtEpochMs: round(nodeStartEpochMs),
    pointerDownAtEpochMs: browserMeasure?.startedAtEpochMs ?? null,
    domReadyAtEpochMs: browserMeasure?.domReadyAtEpochMs ?? null,
    paintFeedbackAtEpochMs: browserMeasure?.paintFeedbackAtEpochMs ?? null,
    timingSource: browserMeasure ? "page pointerdown to DOM-ready and two animation frames; durationMs is next-frame feedback" : "automation-observed fallback",
    ok: !error && Boolean(browserMeasure),
    ...(error ? { error: String(error.message || error).slice(0, 500) } : {}),
    ...(!browserMeasure ? { measurementReason: "page event/state observer did not capture this action" } : {}),
  });
  for (const target of targetMeasures.slice(1)) {
    const measure = browserMeasures.get(target.id);
    output.push({
      action: target.action,
      actionId: id,
      cacheClass: spec.cacheClass,
      delayMs: spec.delayMs,
      nodeClickStartedAtMs: round(nodeStart),
      durationMs: measure?.paintFeedbackMs ?? null,
      domReadyMs: measure?.domReadyMs ?? null,
      paintFeedbackMs: measure?.paintFeedbackMs ?? null,
      nodeClickStartedAtEpochMs: round(nodeStartEpochMs),
      pointerDownAtEpochMs: measure?.startedAtEpochMs ?? null,
      domReadyAtEpochMs: measure?.domReadyAtEpochMs ?? null,
      paintFeedbackAtEpochMs: measure?.paintFeedbackAtEpochMs ?? null,
      timingSource: "same page pointerdown to target DOM-ready and two animation frames",
      ok: Boolean(measure),
      ...(!measure ? { measurementReason: `target did not become visibly ready: ${target.targetSelector}` } : {}),
    });
  }
  network.currentActionId = null;
  network.currentAction = null;
  const missingTargetMeasures = targetMeasures.filter(target => !browserMeasures.get(target.id));
  if (error || missingTargetMeasures.length > 0) {
    const diagnosticId = `${spec.action}-${Date.now()}`;
    const diagnostic = await page.evaluate(measureId => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      activeMeasurement: window.__phoneUxDebug?.(measureId) ?? null,
      bodyText: document.body?.innerText?.slice(0, 4000) ?? "",
    }), targetMeasures.map(target => target.id)).catch(caught => ({ pageEvaluationError: String(caught.message || caught) }));
    await page.screenshot({ path: context.pathInArtifacts(`failure-${diagnosticId}.png`), fullPage: true }).catch(() => undefined);
    await context.writeArtifactJson(`failure-${diagnosticId}.json`, {
      action: spec.action,
      missingTargetMeasures: missingTargetMeasures.map(target => ({ action: target.action, selector: target.targetSelector })),
      urlBefore,
      urlAfter: page.url(),
      error: error ? String(error.message || error).slice(0, 500) : null,
      diagnostic: context.redactValue(diagnostic),
      recentHttp: network.http.slice(-40),
      recentHttpAppliedDelays: network.httpResponsePathDelays.slice(-40),
      recentRpc: network.rpc.slice(-60),
      recentRpcEvents: network.rpcEvents.slice(-120),
      recentWebsocketAppliedDelays: network.websocketResponsePathDelays.slice(-60),
      rpcMethodCounts: network.rpcMethodCounts,
      failedRequests: network.failedRequests,
    });
  }
  if (error) throw error;
  assert.equal(missingTargetMeasures.length, 0, `page event measurement missing for ${missingTargetMeasures.map(target => target.action).join(", ")}`);
}

async function measureDrawerAndInput(page, output, delayMs, cacheClass, index, network, sourceMode, context, navigationOnly) {
  network.currentStage = `${sourceMode}:${cacheClass}:drawer-opening`;
  await measureClick(page, output, {
    action: "drawer-open",
    cacheClass,
    delayMs,
    sourceSelector: '[aria-label="打开任务列表"]',
    targetSelector: '[data-testid="mobile-drawer"]',
    targetVisible: true,
    click: () => page.getByLabel("打开任务列表", { exact: true }).click(),
    wait: () => page.getByTestId("mobile-drawer").waitFor({ state: "visible", timeout: 15_000 }),
  }, context, network);
  network.currentStage = `${sourceMode}:${cacheClass}:drawer-open`;
  await delay(100);
  if (sourceMode === "after") {
    await page.getByTestId(`drawer-load-server-${SERVER_ID}`).waitFor({ state: "visible", timeout: 5_000 });
    await page.getByTestId(`drawer-load-projects-${SERVER_ID}`).waitFor({ state: "visible", timeout: 5_000 });
  }
  const drawerDomTrace = await beginDrawerCloseDomTrace(page, drawerCloseDiagnosticsEnabled);
  network.currentStage = `${sourceMode}:${cacheClass}:drawer-close-attempt`;
  const threadListBeforeClose = threadListRpcCount(network.rpcMethodCounts);
  const drawerCloseWindow = {
    baselineAtMs: round(performance.now()),
    baselineAtEpochMs: round(epochNow()),
    baselineThreadListCount: threadListBeforeClose,
    rpcEventStartIndex: network.rpcEvents.length,
    routedSocketCloseStartIndex: network.routedWebSocketCloseEvents.length,
    routedSocketCloseInvocationStartIndex: network.routedWebSocketCloseInvocations.length,
  };
  drawerCloseWindow.pendingAtBaseline = pendingRouteRequestsAt(network, drawerCloseWindow.baselineAtEpochMs);
  drawerCloseWindow.measureClickWrapperStartedAtMs = round(performance.now());
  drawerCloseWindow.measureClickWrapperStartedAtEpochMs = round(epochNow());
  try {
    await measureClick(page, output, {
      action: "drawer-close",
      cacheClass,
      delayMs,
      sourceSelector: '[aria-label="关闭导航"]',
      targetSelector: '[data-testid="mobile-drawer"]',
      targetVisible: false,
      click: () => page.getByLabel("关闭导航", { exact: true }).last().click(),
      wait: () => page.getByTestId("mobile-drawer").waitFor({ state: "hidden", timeout: 15_000 }),
    }, context, network);
  } catch (error) {
    drawerCloseWindow.measureClickWaitResolvedAtMs = round(performance.now());
    drawerCloseWindow.measureClickWaitResolvedAtEpochMs = round(epochNow());
    drawerCloseWindow.domTrace = await finishDrawerCloseDomTrace(page, drawerDomTrace);
    throw error;
  }
  drawerCloseWindow.measureClickWaitResolvedAtMs = round(performance.now());
  drawerCloseWindow.measureClickWaitResolvedAtEpochMs = round(epochNow());
  drawerCloseWindow.domTrace = await finishDrawerCloseDomTrace(page, drawerDomTrace);
  drawerCloseWindow.hiddenMeasure = output.filter(row => row.action === "drawer-close" && row.cacheClass === cacheClass && row.delayMs === delayMs).at(-1) ?? null;
  await delay(100);
  drawerCloseWindow.quietWindowEndedAtMs = round(performance.now());
  drawerCloseWindow.quietWindowEndedAtEpochMs = round(epochNow());
  const threadListAfterClose = threadListRpcCount(network.rpcMethodCounts);
  const closeScanRequests = Math.max(0, threadListAfterClose - threadListBeforeClose);
  const drawerCloseCheck = {
    cacheClass,
    delayMs,
    requestsAfterClose: closeScanRequests,
    requestsAfterCloseCountScope: "global aggregate across instrumented BrowserContexts; count delta alone does not attribute a request to the active page",
    drawerCloseDiagnosticsEnabled,
    diagnosticLatencyInterpretation: drawerCloseDiagnosticsEnabled ? "instrumented diagnostic timing; not an unbiased latency measurement" : "standard browser timing",
    closeCommitObservation: "React close commit is not read directly; the trace records user input, DOM mutations, CSS transitions, and the existing hidden/paint marker",
    baselineAtMs: drawerCloseWindow.baselineAtMs,
    baselineAtEpochMs: drawerCloseWindow.baselineAtEpochMs,
    measureClickWrapperStartedAtMs: drawerCloseWindow.measureClickWrapperStartedAtMs,
    measureClickWrapperStartedAtEpochMs: drawerCloseWindow.measureClickWrapperStartedAtEpochMs,
    pointerDownAtEpochMs: drawerCloseWindow.hiddenMeasure?.pointerDownAtEpochMs ?? null,
    domHiddenAtEpochMs: drawerCloseWindow.hiddenMeasure?.domReadyAtEpochMs ?? null,
    paintFeedbackAtEpochMs: drawerCloseWindow.hiddenMeasure?.paintFeedbackAtEpochMs ?? null,
    measureClickWaitResolvedAtMs: drawerCloseWindow.measureClickWaitResolvedAtMs,
    measureClickWaitResolvedAtEpochMs: drawerCloseWindow.measureClickWaitResolvedAtEpochMs,
    quietWindowEndedAtMs: drawerCloseWindow.quietWindowEndedAtMs,
    quietWindowEndedAtEpochMs: drawerCloseWindow.quietWindowEndedAtEpochMs,
    baselineThreadListCount: threadListBeforeClose,
    afterQuietThreadListCount: threadListAfterClose,
    pendingAtBaseline: drawerCloseWindow.pendingAtBaseline,
    pendingAtWindowEnd: pendingRouteRequestsAt(network, drawerCloseWindow.quietWindowEndedAtEpochMs),
    domTrace: drawerCloseWindow.domTrace,
    rpcEventStartIndex: drawerCloseWindow.rpcEventStartIndex,
    routedSocketCloseStartIndex: drawerCloseWindow.routedSocketCloseStartIndex,
    routedSocketCloseInvocationStartIndex: drawerCloseWindow.routedSocketCloseInvocationStartIndex,
  };
  network.drawerCloseListChecks.push(drawerCloseCheck);
  network.currentStage = `${sourceMode}:${cacheClass}:drawer-closed`;
  if (sourceMode === "after" && closeScanRequests !== 0) {
    const activePageEvidence = await collectPreShimNativeWebSocketEvidence(page, network);
    const rpcFrameCorrelation = correlateRpcFrames(network);
    const routeSocketOwnerById = new Map(network.routedWebSocketConnections.map(socket => [socket.id, socket.owningPageId ?? null]));
    const withRouteSocketOwner = event => ({
      ...event,
      owningPageId: routeSocketOwnerById.get(event.routeSocketId) ?? null,
    });
    const socketPageAssociations = rpcFrameCorrelation.socketPairs.map(pair => ({
      routeSocketId: pair.routeSocketId,
      applicationPageId: pair.applicationPageId,
      applicationSocketId: pair.applicationSocketId,
      pairingMode: pair.pairingMode,
    }));
    const failureAtEpochMs = round(epochNow());
    const closeWindowRpcEvents = network.rpcEvents.filter(event =>
      event.atEpochMs >= drawerCloseWindow.baselineAtEpochMs
      && event.atEpochMs <= drawerCloseWindow.quietWindowEndedAtEpochMs
      && (event.method === "thread/list" || event.method === "thread.list"),
    ).slice(-160);
    const diagnosticId = `drawer-close-${delayMs}ms-${cacheClass}-${index + 1}-${Date.now()}`;
    const screenshot = await capturePrivateFailureScreenshot(context, page, `${diagnosticId}.png`);
    const failure = context.redactValue({
      schemaVersion: 1,
      evidenceKind: "drawer-close thread/list observation window failure diagnostic",
      classification: "assertion failure preserved; this does not by itself prove a product cancellation defect because the 180ms close animation may admit work before close commit",
      cacheClass,
      delayMs,
      sampleIndex: index + 1,
      requestCountWindow: drawerCloseCheck,
      pendingAtBaseline: drawerCloseWindow.pendingAtBaseline.map(withRouteSocketOwner),
      diagnosticCapturedAtEpochMs: failureAtEpochMs,
      pendingAtWindowEnd: drawerCloseCheck.pendingAtWindowEnd.map(withRouteSocketOwner),
      activePageId: activePageEvidence?.pageId ?? null,
      routedSocketOwners: network.routedWebSocketConnections.map(socket => ({
        routeSocketId: socket.id,
        owningPageId: socket.owningPageId ?? null,
        path: socket.path,
        serverFingerprint: socket.serverFingerprint,
        channelFingerprint: socket.channelFingerprint,
        workspaceFingerprint: socket.workspaceFingerprint,
        openedAtEpochMs: socket.atEpochMs,
      })),
      routeSocketPageAssociations: socketPageAssociations,
      relevantThreadListRpcEvents: closeWindowRpcEvents.map(event => {
        const associations = socketPageAssociations.filter(pair => pair.routeSocketId === event.routeSocketId);
        return {
          ...sanitizeRpcEventForCheckpoint(event),
          owningPageId: routeSocketOwnerById.get(event.routeSocketId) ?? null,
          routeSocketPageAssociations: associations,
          activePageAssociation: activePageEvidence?.pageId == null
            ? "UNAVAILABLE"
            : associations.some(pair => pair.applicationPageId === activePageEvidence.pageId) ? "MATCHED_ACTIVE_PAGE" : associations.length ? "MATCHED_OTHER_PAGE" : "UNPAIRED_OR_AMBIGUOUS",
        };
      }),
      socketPairingDiagnostics: {
        socketPairCount: rpcFrameCorrelation.socketPairCount,
        ambiguousSocketGroups: rpcFrameCorrelation.ambiguousSocketGroups,
        unpairedRouteSockets: rpcFrameCorrelation.unpairedRouteSockets,
        activePageCapture: activePageEvidence,
      },
      routedSocketCloseEvents: network.routedWebSocketCloseEvents.slice(drawerCloseWindow.routedSocketCloseStartIndex).filter(event => event.atEpochMs <= drawerCloseWindow.quietWindowEndedAtEpochMs).map(withRouteSocketOwner),
      routedSocketCloseInvocations: network.routedWebSocketCloseInvocations.slice(drawerCloseWindow.routedSocketCloseInvocationStartIndex).filter(event => event.atEpochMs <= drawerCloseWindow.quietWindowEndedAtEpochMs).map(withRouteSocketOwner),
      drawerDomTrace: drawerCloseWindow.domTrace,
      drawerDomStateAtFailure: await describeDrawerCloseState(page),
      screenshot,
      sourceTimingBoundary: "Node epoch timestamps bracket the close attempt and existing 100ms observation window; page DOM trace records page performance and epoch clocks when --drawer-close-diagnostics is enabled; aggregate count is not attributed to the active page unless the route socket pairs uniquely",
    });
    await context.writeArtifactJson(`${diagnosticId}.json`, failure);
  }
  if (sourceMode === "after") assert.equal(closeScanRequests, 0, "closing the task drawer must not issue additional thread/list requests");
  const id = `input-${index}-${Math.random().toString(36).slice(2)}`;
  const value = `P0 draft ${index}`;
  await page.evaluate(spec => window.__phoneUxArm(spec), {
    id,
    sourceSelector: '[data-testid="message-input"]',
    targetSelector: '[data-testid="message-input"]',
    targetValue: value,
  });
  const input = page.getByTestId("message-input");
  await input.fill(value);
  const measure = await page.waitForFunction(measureId => window.__phoneUxMeasure(measureId), id, { timeout: 5_000 })
    .then(handle => handle.jsonValue())
    .catch(() => null);
  output.push({
    action: "input-feedback",
    cacheClass,
    delayMs,
    durationMs: measure?.paintFeedbackMs ?? null,
    domReadyMs: measure?.domReadyMs ?? null,
    paintFeedbackMs: measure?.paintFeedbackMs ?? null,
    timingSource: "page input event to DOM value update and two animation frames",
    ok: Boolean(measure),
    ...(!measure ? { measurementReason: "input event/state observer did not capture the value" } : {}),
  });
  assert.ok(measure, "page input feedback measurement should be captured");

  if (navigationOnly) return;

  const pendingMessage = `PHONE_UX_PENDING_${cacheClass}_${delayMs}_${index}_${Date.now()}`;
  network.currentStage = `${sourceMode}:${cacheClass}:send-local-pending`;
  await input.fill(pendingMessage);
  await measureClick(page, output, {
    action: "send-local-pending",
    cacheClass,
    delayMs,
    sourceSelector: '[data-testid="send-message"]',
    targetSelector: '[data-testid="failed-submission-content"]',
    targetVisible: true,
    additionalTargets: [
      { action: "mock-gateway-turn-start-ack", targetSelector: '[data-testid="failed-submission-content"]', targetVisible: false, requireTargetTransition: true, targetText: pendingMessage },
    ],
    targetText: pendingMessage,
    click: () => page.getByTestId("send-message").click(),
    wait: async () => {},
  }, context, network);
  await page.getByTestId("stop-turn").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("stop-turn").click();
  await page.getByTestId("stop-turn").waitFor({ state: "hidden", timeout: 30_000 });
  await waitForGatewayRpcQuiescence(network);
  network.currentStage = `${sourceMode}:${cacheClass}:send-complete`;
}

async function beginDrawerCloseDomTrace(page, enabled) {
  if (!enabled) return { enabled: false, status: "disabled" };
  return page.evaluate(() => {
    const key = "__phoneUxDrawerCloseTraceV1";
    const drawer = document.querySelector('[data-testid="mobile-drawer"]');
    const events = [];
    const describe = element => {
      if (!(element instanceof Element)) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        tagName: element.tagName.toLowerCase(),
        testId: element.getAttribute("data-testid"),
        ariaLabel: element.getAttribute("aria-label"),
        ariaHidden: element.getAttribute("aria-hidden"),
        hidden: element.hasAttribute("hidden"),
        visibility: style.visibility,
        display: style.display,
        opacity: style.opacity,
        transform: style.transform,
        rect: { x: Math.round(rect.x * 10) / 10, y: Math.round(rect.y * 10) / 10, width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 },
      };
    };
    const record = (kind, event = null, extra = {}) => {
      events.push({
        kind,
        atPagePerformanceMs: Math.round(performance.now() * 1000) / 1000,
        atEpochMs: Date.now(),
        target: describe(event?.target ?? drawer),
        ...extra,
      });
      if (events.length > 160) events.splice(0, events.length - 160);
    };
    const onPointer = event => {
      const target = event.target instanceof Element ? event.target.closest('[aria-label="关闭导航"]') : null;
      if (target) record(event.type, event, { control: describe(target) });
    };
    const onTransition = event => record(event.type, event, { propertyName: event.propertyName, elapsedTimeSeconds: event.elapsedTime });
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("pointerup", onPointer, true);
    document.addEventListener("click", onPointer, true);
    drawer?.addEventListener("transitionrun", onTransition, true);
    drawer?.addEventListener("transitionstart", onTransition, true);
    drawer?.addEventListener("transitionend", onTransition, true);
    drawer?.addEventListener("transitioncancel", onTransition, true);
    const observer = drawer ? new MutationObserver(records => {
      for (const mutation of records) record("drawer-mutation", null, { attributeName: mutation.attributeName });
    }) : null;
    observer?.observe(drawer, { attributes: true, attributeFilter: ["class", "style", "aria-hidden", "hidden", "data-state"] });
    const trace = {
      enabled: true,
      status: drawer ? "armed" : "drawer-not-found",
      armedAtPagePerformanceMs: Math.round(performance.now() * 1000) / 1000,
      pageTimeOriginEpochMs: performance.timeOrigin,
      armedAtEpochMs: Date.now(),
      events,
      cleanup() {
        document.removeEventListener("pointerdown", onPointer, true);
        document.removeEventListener("pointerup", onPointer, true);
        document.removeEventListener("click", onPointer, true);
        drawer?.removeEventListener("transitionrun", onTransition, true);
        drawer?.removeEventListener("transitionstart", onTransition, true);
        drawer?.removeEventListener("transitionend", onTransition, true);
        drawer?.removeEventListener("transitioncancel", onTransition, true);
        observer?.disconnect();
      },
    };
    globalThis[key]?.cleanup?.();
    globalThis[key] = trace;
    return { enabled: true, status: trace.status, armedAtPagePerformanceMs: trace.armedAtPagePerformanceMs, pageTimeOriginEpochMs: trace.pageTimeOriginEpochMs, armedAtEpochMs: trace.armedAtEpochMs };
  }).catch(error => ({ enabled: true, status: "arm-failed", error: String(error?.message ?? error).slice(0, 200) }));
}

async function finishDrawerCloseDomTrace(page, trace) {
  if (!trace?.enabled) return trace;
  return page.evaluate(() => {
    const key = "__phoneUxDrawerCloseTraceV1";
    const current = globalThis[key];
    if (!current) return { enabled: true, status: "trace-missing" };
    current.cleanup?.();
    const result = {
      enabled: true,
      status: current.status,
      armedAtPagePerformanceMs: current.armedAtPagePerformanceMs,
      pageTimeOriginEpochMs: current.pageTimeOriginEpochMs,
      armedAtEpochMs: current.armedAtEpochMs,
      events: current.events,
      capturedAtPagePerformanceMs: Math.round(performance.now() * 1000) / 1000,
      capturedAtEpochMs: Date.now(),
    };
    delete globalThis[key];
    return result;
  }).catch(error => ({ enabled: true, status: "capture-failed", error: String(error?.message ?? error).slice(0, 200) }));
}

async function describeDrawerCloseState(page) {
  return page.evaluate(() => {
    const describe = element => {
      if (!(element instanceof Element)) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        tagName: element.tagName.toLowerCase(),
        testId: element.getAttribute("data-testid"),
        ariaLabel: element.getAttribute("aria-label"),
        ariaHidden: element.getAttribute("aria-hidden"),
        hidden: element.hasAttribute("hidden"),
        visibility: style.visibility,
        display: style.display,
        opacity: style.opacity,
        transform: style.transform,
        rect: { x: Math.round(rect.x * 10) / 10, y: Math.round(rect.y * 10) / 10, width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 },
      };
    };
    const drawer = document.querySelector('[data-testid="mobile-drawer"]');
    const closeControls = [...document.querySelectorAll('[aria-label="关闭导航"]')].map(describe);
    return {
      pageEpochMs: Date.now(),
      pagePerformanceMs: Math.round(performance.now() * 1000) / 1000,
      pathname: globalThis.location?.pathname ?? null,
      drawer: describe(drawer),
      closeControlCount: closeControls.length,
      closeControls,
    };
  }).catch(error => ({ status: "capture-failed", error: String(error?.message ?? error).slice(0, 200) }));
}

function sanitizeRpcEventForCheckpoint(event) {
  return {
    direction: event.direction,
    method: event.method,
    rpcIdFingerprint: event.rpcIdFingerprint ?? null,
    atMs: event.atMs,
    atEpochMs: event.atEpochMs,
    stage: event.stage,
    actionId: event.actionId,
    routeSocketId: event.routeSocketId,
    path: typeof event.path === "string" ? sanitizeGatewayPath(event.path) : null,
    serverFingerprint: event.serverFingerprint ?? null,
    channelFingerprint: event.channelFingerprint ?? null,
    workspaceFingerprint: event.workspaceFingerprint ?? null,
  };
}

function pendingRouteRequestsAt(network, atEpochMs) {
  const events = [
    ...network.rpcEvents.map(event => ({ kind: "rpc", event })),
    ...network.routedWebSocketCloseEvents.map(event => ({ kind: "close", event })),
  ].filter(row => row.event.atEpochMs <= atEpochMs).sort((a, b) => a.event.atEpochMs - b.event.atEpochMs);
  const pending = new Map();
  for (const row of events) {
    const event = row.event;
    if (row.kind === "close") {
      for (const [key, request] of pending) if (request.routeSocketId === event.routeSocketId) pending.delete(key);
      continue;
    }
    if (event.direction === "request" && event.hasId && event.rpcIdFingerprint) {
      const key = `${event.routeSocketId}|${event.method}|${event.rpcIdFingerprint}`;
      pending.set(key, event);
    } else if (event.direction === "response-forwarded" || event.direction === "response-dropped") {
      pending.delete(`${event.routeSocketId}|${event.method}|${event.rpcIdFingerprint}`);
    }
  }
  return [...pending.values()].map(sanitizeRpcEventForCheckpoint);
}

function recordRoutedWebSocketCloseInvocation(network, routeSocketId, { code, reason, stage, actionId }) {
  network.routedWebSocketCloseInvocations.push({
    routeSocketId,
    code,
    reason,
    atMs: round(performance.now()),
    atEpochMs: round(epochNow()),
    stage,
    actionId,
    owner: "test-fixture",
  });
}

function beginNavigationSampleCapture(network, observations, browserErrors, delayMs, cacheClass, sampleIndex) {
  const ordinal = ++network.navigationSampleSequence;
  return {
    ordinal,
    delayMs,
    cacheClass,
    sampleIndex,
    startedAtEpochMs: round(epochNow()),
    observationStartIndex: observations.length,
    browserErrorStartIndex: browserErrors.length,
    httpRouteRequestStartIndex: network.httpRouteRequests.length,
    httpResponseDelayStartIndex: network.httpResponsePathDelays.length,
    rpcEventStartIndex: network.rpcEvents.length,
    websocketDelayStartIndex: network.websocketResponsePathDelays.length,
    routedSocketStartIndex: network.routedWebSocketConnections.length,
    routedSocketCloseStartIndex: network.routedWebSocketCloseEvents.length,
    routedSocketCloseInvocationStartIndex: network.routedWebSocketCloseInvocations.length,
    drawerCheckStartIndex: network.drawerCloseListChecks.length,
    websocketFrameCountAtStart: network.websocketFrames,
  };
}

async function writeNavigationSampleCheckpoint(context, network, capture, observations, browserErrors) {
  const finishedAtEpochMs = round(epochNow());
  const safeHttpRequest = row => ({
    routeRequestOrdinal: row.routeRequestOrdinal ?? null,
    path: sanitizeGatewayPath(row.apiPath ?? row.path),
    method: row.method,
    stage: row.stage,
    scenario: row.scenario ?? null,
    startedAtEpochMs: row.startedAtEpochMs ?? null,
  });
  const safeHttpResponse = row => ({
    routeRequestOrdinal: row.routeRequestOrdinal ?? null,
    path: sanitizeGatewayPath(row.apiPath ?? row.path),
    method: row.method,
    status: row.status,
    configuredDelayMs: row.configuredDelayMs,
    appliedDelayMs: row.appliedDelayMs,
    startedAtEpochMs: row.requestStartedAtEpochMs ?? null,
    forwardedAtEpochMs: row.forwardedAtEpochMs ?? null,
    stage: row.stage,
    scenario: row.scenario ?? null,
  });
  const safeWsDelay = row => ({
    method: row.method,
    rpcIdFingerprint: row.rpcIdFingerprint ?? null,
    routeSocketId: row.routeSocketId,
    configuredDelayMs: row.configuredDelayMs,
    appliedDelayMs: row.appliedDelayMs,
    receivedAtEpochMs: row.receivedAtEpochMs ?? null,
    forwardedAtEpochMs: row.forwardedAtEpochMs ?? null,
    stage: row.stage,
    scenario: row.scenario ?? null,
  });
  const httpRequests = network.httpRouteRequests.slice(capture.httpRouteRequestStartIndex).map(safeHttpRequest);
  const httpResponses = network.httpResponsePathDelays.slice(capture.httpResponseDelayStartIndex).map(safeHttpResponse);
  const rpcEvents = network.rpcEvents.slice(capture.rpcEventStartIndex).map(sanitizeRpcEventForCheckpoint);
  const websocketDelays = network.websocketResponsePathDelays.slice(capture.websocketDelayStartIndex).map(safeWsDelay);
  const routeSockets = network.routedWebSocketConnections.slice(capture.routedSocketStartIndex).map(row => ({
    id: row.id,
    path: typeof row.path === "string" ? sanitizeGatewayPath(row.path) : null,
    serverFingerprint: row.serverFingerprint ?? null,
    channelFingerprint: row.channelFingerprint ?? null,
    workspaceFingerprint: row.workspaceFingerprint ?? null,
    atEpochMs: row.atEpochMs,
    stage: row.stage,
  }));
  const sample = context.redactValue({
    schemaVersion: 1,
    evidenceKind: "completed Mobile Web navigation sample checkpoint",
    sample: {
      ordinal: capture.ordinal,
      delayMs: capture.delayMs,
      cacheClass: capture.cacheClass,
      sampleIndex: capture.sampleIndex,
      requiredSamplesPerClass: capture.cacheClass === "profile-setup" ? 1 : sampleCount,
      percentileEligible: capture.cacheClass !== "profile-setup" && sampleCount >= DEFAULT_SAMPLES,
      drawerCloseDiagnosticsEnabled,
      drawerCloseLatencyInterpretation: drawerCloseDiagnosticsEnabled ? "instrumented diagnostic timing; not an unbiased latency measurement" : "standard browser timing",
      startedAtEpochMs: capture.startedAtEpochMs,
      finishedAtEpochMs,
      wallElapsedMs: round(finishedAtEpochMs - capture.startedAtEpochMs),
      browserActionTimingExcludesCheckpointIo: true,
    },
    captureStatus: "COMPLETED",
    sampleOutcome: browserErrors.length > capture.browserErrorStartIndex ? "ERROR" : "NO_PAGEERROR_OBSERVED",
    observations: observations.slice(capture.observationStartIndex),
    browserErrorCount: browserErrors.length - capture.browserErrorStartIndex,
    network: {
      associationSemantics: "request-path observations are bounded by this sample window; method/id/socket/stage/action/time fields support correlation, while background fixture traffic in a live context is not automatically attributed to the measured click",
      pendingAtCheckpoint: pendingGatewayActivity(network),
      outstandingRpcRequestsAtCheckpoint: pendingRouteRequestsAt(network, finishedAtEpochMs),
      httpRouteRequestCount: httpRequests.length,
      httpResponsePathCount: httpResponses.length,
      websocketFrameCount: network.websocketFrames - capture.websocketFrameCountAtStart,
      websocketResponsePathCount: websocketDelays.length,
      rpcEventCount: rpcEvents.length,
      routeSocketCount: routeSockets.length,
      routedSocketCloseEvents: network.routedWebSocketCloseEvents.slice(capture.routedSocketCloseStartIndex),
      routedSocketCloseInvocations: network.routedWebSocketCloseInvocations.slice(capture.routedSocketCloseInvocationStartIndex),
      httpRequests,
      httpResponses,
      rpcEvents,
      websocketResponsePaths: websocketDelays,
      routeSockets,
      drawerCloseChecks: network.drawerCloseListChecks.slice(capture.drawerCheckStartIndex),
    },
    storageStatePersisted: false,
    credentialsOrResponseBodiesIncluded: false,
  });
  const cacheKey = capture.cacheClass.replace(/[^a-z0-9-]/gi, "-");
  const sampleKey = capture.sampleIndex === 0 ? "setup" : String(capture.sampleIndex).padStart(2, "0");
  await context.writeArtifactJson(`phone-ux-navigation-${capture.delayMs}ms-${cacheKey}-${sampleKey}-s${String(capture.ordinal).padStart(4, "0")}.json`, sample);
}

async function installPageInstrumentation(page, pageId) {
  await page.addInitScript(({ pageId }) => {
    const activeKey = "__phoneUxActiveMeasurementsV1";
    const completedKey = "__phoneUxCompletedMeasurementsV1";
    const debugKey = "__phoneUxEventDebugV1";
    const readStored = key => {
      try { return JSON.parse(sessionStorage.getItem(key) || "[]"); } catch { return []; }
    };
    const active = new Map(readStored(activeKey).map(measurement => [measurement.id, measurement]));
    const completed = new Map(readStored(completedKey));
    const longTasks = [];
    const events = readStored(debugKey);
    const appSocketKey = "__phoneUxApplicationWebSocketConnectionsV1";
    const appFrameKey = "__phoneUxApplicationWebSocketFramesV1";
    const appSockets = readStored(appSocketKey);
    const appFrames = readStored(appFrameKey);
    const pendingAppFrameWrites = new Set();
    const maxAppSockets = 512;
    const maxAppFrames = 8192;
    let socketOverflowCount = 0;
    let frameOverflowCount = 0;
    let storageWriteFailureCount = 0;
    let appSocketSequence = Math.max(0, ...appSockets.map(row => Number(row.socketId) || 0));
    const storeAppEvidence = () => {
      try {
        sessionStorage.setItem(appSocketKey, JSON.stringify(appSockets));
        sessionStorage.setItem(appFrameKey, JSON.stringify(appFrames));
      } catch { storageWriteFailureCount += 1; }
    };
    const digestFingerprint = async value => {
      const bytes = new TextEncoder().encode(String(value));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    };
    const applicationRouteInfo = async rawUrl => {
      try {
        const parsed = new URL(rawUrl, location.href);
        const fingerprint = async names => {
          for (const name of names) {
            const value = parsed.searchParams.get(name);
            if (value) return (await digestFingerprint(`${name}:${value}`)).slice(0, 12);
          }
          return null;
        };
        return {
          path: parsed.pathname,
          serverFingerprint: await fingerprint(["serverId", "server"]),
          channelFingerprint: await fingerprint(["channelId", "channel"]),
          workspaceFingerprint: await fingerprint(["workspaceId", "workspace"]),
        };
      } catch {
        return { path: "<invalid-url>", serverFingerprint: null, channelFingerprint: null, workspaceFingerprint: null };
      }
    };
    const recordApplicationFrame = (socket, direction, raw, atEpochMs, eventTimestampEpochMs = null) => {
      const pending = (async () => {
        if (typeof raw !== "string") return;
        let frame;
        try { frame = JSON.parse(raw); } catch { return; }
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
        const hasId = Object.hasOwn(frame, "id");
        const hasResult = Object.hasOwn(frame, "result");
        const hasError = Object.hasOwn(frame, "error");
        const method = typeof frame.method === "string" ? frame.method : null;
        if (!hasId && !hasResult && !hasError && method === null) return;
        const idFingerprint = hasId ? (await digestFingerprint(frame.id)).slice(0, 16) : null;
        const routeInfo = await socket.routeInfo;
        if (appFrames.length >= maxAppFrames) {
          frameOverflowCount += 1;
          return;
        }
        appFrames.push({
          pageId,
          direction,
          socketId: socket.socketId,
          ...routeInfo,
          method,
          rpcIdFingerprint: idFingerprint,
          hasId,
          hasResult,
          hasError,
          atEpochMs: Number(atEpochMs.toFixed(3)),
          eventTimestampEpochMs: Number.isFinite(eventTimestampEpochMs) ? Number(eventTimestampEpochMs.toFixed(3)) : null,
        });
        storeAppEvidence();
      })();
      pendingAppFrameWrites.add(pending);
      void pending.finally(() => pendingAppFrameWrites.delete(pending));
    };
    const NativeWebSocket = window.WebSocket;
    const nativeSend = NativeWebSocket.prototype.send;
    const socketMetadata = new WeakMap();
    NativeWebSocket.prototype.send = function phoneUxInstrumentedSend(raw) {
      const socket = socketMetadata.get(this);
      if (socket) recordApplicationFrame(socket, "sent", raw, performance.timeOrigin + performance.now());
      return nativeSend.call(this, raw);
    };
    const InstrumentedWebSocket = function PhoneUxInstrumentedWebSocket(...args) {
      if (!new.target) throw new TypeError("WebSocket constructor requires 'new'");
      const socket = Reflect.construct(NativeWebSocket, args, NativeWebSocket);
      const metadata = {
        pageId,
        socketId: ++appSocketSequence,
        routeInfo: applicationRouteInfo(args[0]),
      };
      socketMetadata.set(socket, metadata);
      const pendingSocketCapture = metadata.routeInfo.then(routeInfo => {
        if (appSockets.length >= maxAppSockets) {
          socketOverflowCount += 1;
          return;
        }
        appSockets.push({
          pageId,
          socketId: metadata.socketId,
          ...routeInfo,
          atEpochMs: Number((performance.timeOrigin + performance.now()).toFixed(3)),
        });
        storeAppEvidence();
      });
      pendingAppFrameWrites.add(pendingSocketCapture);
      void pendingSocketCapture.finally(() => pendingAppFrameWrites.delete(pendingSocketCapture));
      socket.addEventListener("message", event => {
        const callbackEpochMs = performance.timeOrigin + performance.now();
        const eventTimestampEpochMs = performance.timeOrigin + event.timeStamp;
        recordApplicationFrame(metadata, "received", event.data, callbackEpochMs, eventTimestampEpochMs);
      });
      return socket;
    };
    Object.setPrototypeOf(InstrumentedWebSocket, NativeWebSocket);
    InstrumentedWebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket = InstrumentedWebSocket;
    window.__phoneUxDrainApplicationWebSocketEvidence = async () => {
      while (pendingAppFrameWrites.size > 0) await Promise.all([...pendingAppFrameWrites]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      while (pendingAppFrameWrites.size > 0) await Promise.all([...pendingAppFrameWrites]);
      const evidence = {
        pageId,
        sockets: appSockets.slice(),
        frames: appFrames.slice(),
        socketOverflowCount,
        frameOverflowCount,
        storageWriteFailureCount,
        maxSocketsPerPage: maxAppSockets,
        maxFramesPerPage: maxAppFrames,
      };
      appSockets.length = 0;
      appFrames.length = 0;
      storeAppEvidence();
      return evidence;
    };
    storeAppEvidence();
    const absoluteNow = () => performance.timeOrigin + performance.now();
    const persist = () => {
      try {
        sessionStorage.setItem(activeKey, JSON.stringify([...active.values()]));
        sessionStorage.setItem(completedKey, JSON.stringify([...completed.entries()].slice(-64)));
        sessionStorage.setItem(debugKey, JSON.stringify(events.slice(-64)));
      } catch {}
    };
    const noteEvent = (measurement, eventType, target) => {
      events.push({ id: measurement.id, eventType, targetTag: target?.tagName ?? null, targetTestId: target?.getAttribute?.("data-testid") ?? null, at: Number(absoluteNow().toFixed(3)) });
      if (events.length > 64) events.splice(0, events.length - 64);
    };
    const visible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const matches = (target, selector) => {
      if (!(target instanceof Element)) return false;
      try { return Boolean(target.closest(selector)); } catch { return false; }
    };
    const stillReady = measurement => {
      const element = document.querySelector(measurement.targetSelector);
      const textMatches = measurement.targetText === undefined || (element?.textContent ?? "").includes(measurement.targetText);
      if (measurement.requireTargetTransition) {
        const isVisible = visible(element) && textMatches;
        if (isVisible) measurement.targetWasVisible = true;
        return measurement.targetWasVisible === true && !isVisible;
      }
      let ready = visible(element) === measurement.targetVisible && (measurement.targetVisible ? textMatches : true);
      if (measurement.targetValue !== undefined) ready = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value === measurement.targetValue
        : false;
      return ready;
    };
    const finish = measurement => {
      if (measurement.startedAt === null || measurement.domReadyAt !== null || !stillReady(measurement)) return;
      measurement.domReadyAt = absoluteNow();
      measurement.domReadyMs = Number((measurement.domReadyAt - measurement.startedAt).toFixed(3));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!stillReady(measurement)) {
          measurement.domReadyAt = null;
          measurement.domReadyMs = null;
          persist();
          return;
        }
        measurement.finishedAt = absoluteNow();
        measurement.paintFeedbackMs = Number((measurement.finishedAt - measurement.startedAt).toFixed(3));
        completed.set(measurement.id, {
          action: measurement.action ?? null,
          startedAtEpochMs: measurement.startedAt,
          domReadyAtEpochMs: measurement.domReadyAt,
          paintFeedbackAtEpochMs: measurement.finishedAt,
          domReadyMs: measurement.domReadyMs,
          paintFeedbackMs: measurement.paintFeedbackMs,
        });
        active.delete(measurement.id);
        persist();
      }));
    };
    window.__phoneUxArm = spec => {
      active.set(spec.id, { ...spec, startedAt: null, domReadyAt: null, finishedAt: null, domReadyMs: null, paintFeedbackMs: null });
      persist();
    };
    window.__phoneUxMeasure = id => completed.get(id) || null;
    window.__phoneUxDebug = ids => {
      const values = Array.isArray(ids) ? ids : [ids];
      return Object.fromEntries(values.map(id => [id, {
        active: active.get(id) ?? null,
        completed: completed.get(id) ?? null,
        events: events.filter(event => event.id === id),
        url: location.href,
      }]));
    };
    const begin = (event, eventType) => {
      for (const measurement of active.values()) {
        if (measurement.targetValue !== undefined && eventType !== "input") continue;
        if (measurement.targetValue === undefined && eventType !== "pointerdown") continue;
        if (measurement.startedAt !== null || !matches(event.target, measurement.sourceSelector)) continue;
        measurement.startedAt = absoluteNow();
        measurement.eventType = eventType;
        noteEvent(measurement, eventType, event.target);
        persist();
        if (eventType === "input") finish(measurement);
      }
    };
    document.addEventListener("pointerdown", event => begin(event, "pointerdown"), true);
    document.addEventListener("click", event => begin(event, "click"), true);
    document.addEventListener("input", event => begin(event, "input"), true);
    new MutationObserver(() => {
      for (const measurement of active.values()) finish(measurement);
    }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    for (const measurement of active.values()) finish(measurement);
    if (typeof PerformanceObserver === "function") {
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) longTasks.push({ startTimeMs: Number(entry.startTime.toFixed(3)), durationMs: Number(entry.duration.toFixed(3)) });
        }).observe({ type: "longtask", buffered: true });
      } catch {}
    }
    window.__phoneUxLongTasks = () => longTasks.slice();
  }, { pageId });
}

async function installNetworkInstrumentation(page, pageId, ledger, delayControl, gatewayCalls) {
  page.on("websocket", socket => {
    const routeInfo = safeWebSocketRouteInfo(socket.url());
    const path = routeInfo.path;
    const socketId = ++ledger.browserSocketSequence;
    const atMs = round(performance.now());
    ledger.browserWebSocketPaths.push(path);
    ledger.browserWebSocketConnections.push({ id: socketId, ...routeInfo, atMs, atEpochMs: round(epochNow()), stage: ledger.currentStage, actionId: ledger.currentActionId });
    const recordFrame = (direction, event) => {
      const frame = parseFrame(event?.payload);
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
      const method = typeof frame.method === "string" ? frame.method : null;
      const hasId = Object.hasOwn(frame, "id");
      const hasResult = Object.hasOwn(frame, "result");
      const hasError = Object.hasOwn(frame, "error");
      if (method === null && !hasId && !hasResult && !hasError) return;
      if (direction === "sent" && method !== null) ledger.browserFrameMethodCounts[method] = (ledger.browserFrameMethodCounts[method] ?? 0) + 1;
      ledger.browserFrames.push({
        direction,
        socketId,
        ...routeInfo,
        method,
        rpcIdFingerprint: hasId ? rpcIdFingerprint(frame.id) : null,
        hasId,
        hasResult,
        hasError,
        atMs: round(performance.now()),
        atEpochMs: round(epochNow()),
        stage: ledger.currentStage,
        actionId: ledger.currentActionId,
      });
    };
    socket.on("framesent", event => recordFrame("sent", event));
    socket.on("framereceived", event => recordFrame("received", event));
  });
  page.on("request", request => {
    const path = safePath(request.url());
    if (mobileApiPath(path).startsWith("/api/")) ledger.requestStarts.set(request, { path, method: request.method(), at: performance.now() });
  });
  page.on("response", response => {
    const request = response.request();
    const start = ledger.requestStarts.get(request);
    if (!start) return;
    ledger.http.push({ path: start.path, method: start.method, status: response.status(), durationMs: round(performance.now() - start.at), configuredDelayMs: delayControl.delayMs ?? 0 });
  });
  await page.route("**/api/**", async route => {
    ledger.pendingHttpResponses += 1;
    try {
      const path = safePath(route.request().url());
      const apiPath = mobileApiPath(path);
      const method = route.request().method();
      const routeRequestOrdinal = ++ledger.httpRouteRequestSequence;
      const requestStartedAtMs = round(performance.now());
      const requestStartedAtEpochMs = round(epochNow());
      ledger.httpRouteRequests.push({
        routeRequestOrdinal,
        path,
        apiPath,
        method,
        stage: ledger.currentStage,
        scenario: delayControl.scenarioId ?? null,
        startedAtMs: requestStartedAtMs,
        startedAtEpochMs: requestStartedAtEpochMs,
      });
      const response = await route.fetch();
      const jitter = delayControl.responseJitter?.next("http", apiPath) ?? { sampleIndex: null, delayMs: 0 };
      const configuredDelayMs = sumResponseDelayMs(
        delayControl.delayMs ?? 0,
        apiPath === "/api/servers/status" ? (delayControl.statusProbeDelayMs ?? 0) : 0,
        delayControl.httpPathDelayMs?.[apiPath] ?? 0,
        jitter.delayMs,
      );
      const responsePathHoldStartedAt = performance.now();
      const responsePathHoldDeadline = responsePathHoldStartedAt + configuredDelayMs;
      if (configuredDelayMs > 0) await waitUntilPerformanceDeadline(responsePathHoldDeadline);
      const appliedDelayMs = round(performance.now() - responsePathHoldStartedAt);
      const injectedStatus = delayControl.httpStatusOverrides?.[apiPath];
      if (Number.isInteger(injectedStatus)) {
        await route.fulfill({ response, status: injectedStatus });
        ledger.injectedHttpStatuses.push({ path, apiPath, status: injectedStatus, stage: ledger.currentStage, scenario: delayControl.scenarioId ?? null });
      } else {
        await route.fulfill({ response });
      }
      ledger.httpResponsePathDelays.push({
        routeRequestOrdinal,
        path,
        apiPath,
        method,
        requestStartedAtMs,
        requestStartedAtEpochMs,
        forwardedAtEpochMs: round(epochNow()),
        configuredDelayMs,
        jitterSampleIndex: jitter.sampleIndex,
        jitterDelayMs: jitter.delayMs,
        appliedDelayMs,
        status: injectedStatus ?? response.status(),
        stage: ledger.currentStage,
        scenario: delayControl.scenarioId ?? null,
      });
    } finally {
      ledger.pendingHttpResponses = Math.max(0, ledger.pendingHttpResponses - 1);
    }
  });
  const methodResponseHoldTimers = new Set();
  page.on("close", () => {
    const cancelledHoldCount = methodResponseHoldTimers.size;
    for (const timer of methodResponseHoldTimers) clearTimeout(timer);
    methodResponseHoldTimers.clear();
    ledger.pendingWebSocketDeliveries = Math.max(0, ledger.pendingWebSocketDeliveries - cancelledHoldCount);
  });
  await page.routeWebSocket(url => url.pathname.endsWith("/rpc"), socket => {
    const routeSocketId = ++ledger.routedSocketSequence;
    const socketUrl = typeof socket.url === "function" ? socket.url() : socket.url;
    const routeInfo = typeof socketUrl === "string" ? safeWebSocketRouteInfo(socketUrl) : { path: null };
    ledger.routedWebSocketConnections.push({
      id: routeSocketId,
      owningPageId: pageId,
      ...routeInfo,
      atMs: round(performance.now()),
      atEpochMs: round(epochNow()),
      stage: ledger.currentStage,
      actionId: ledger.currentActionId,
    });
    const upstream = socket.connectToServer();
    const pendingRpc = new Map();
    let deliverQueue = Promise.resolve();
    socket.onMessage(raw => {
      const frame = parseFrame(raw);
      if (typeof frame?.method === "string") {
        const idFingerprint = frame.id !== undefined ? rpcIdFingerprint(frame.id) : null;
        ledger.rpcMethodCounts[frame.method] = (ledger.rpcMethodCounts[frame.method] ?? 0) + 1;
        ledger.rpcEvents.push({
          direction: "request",
          method: frame.method,
          rpcIdFingerprint: idFingerprint,
          hasId: frame.id !== undefined,
          atMs: round(performance.now()),
          atEpochMs: round(epochNow()),
          stage: ledger.currentStage,
          actionId: ledger.currentActionId,
          routeSocketId,
          ...routeInfo,
        });
        if (frame.method === "turn/start" && delayControl.scenarioId) {
          ledger.faultFixtureEvents.push({
            scenario: delayControl.scenarioId,
            kind: "turn-start-request",
            rpcIdFingerprint: idFingerprint,
            threadIdFingerprint: typeof frame.params?.threadId === "string" ? sha256(frame.params.threadId).slice(0, 16) : null,
            clientMessageIdFingerprint: typeof frame.params?.clientMessageId === "string" ? sha256(frame.params.clientMessageId).slice(0, 16) : null,
            routeSocketId,
            atMs: round(performance.now()),
            stage: ledger.currentStage,
          });
        }
        if (frame.method === "turn/interrupt" && delayControl.scenarioId) {
          ledger.faultFixtureEvents.push({
            scenario: delayControl.scenarioId,
            kind: "turn-interrupt-request",
            rpcIdFingerprint: idFingerprint,
            threadIdFingerprint: typeof frame.params?.threadId === "string" ? sha256(frame.params.threadId).slice(0, 16) : null,
            turnIdFingerprint: typeof frame.params?.turnId === "string" ? sha256(frame.params.turnId).slice(0, 16) : null,
            routeSocketId,
            atMs: round(performance.now()),
            stage: ledger.currentStage,
          });
        }
        if (frame.method === "turn/start") gatewayCalls.turnStart += 1;
        if (frame.method === "runtime.models.list") gatewayCalls.modelCatalogRpcRequests += 1;
        if (frame.id !== undefined) {
          const receiptRequestIdentity = frame.method === "turn/start"
            ? delayControl.receiptFixture?.observeTurnStartRequest(frame.params, delayControl.receiptScope, routeSocketId)
            : null;
          pendingRpc.set(String(frame.id), {
            method: frame.method,
            stage: ledger.currentStage,
            sentAt: performance.now(),
            sentAtEpochMs: epochNow(),
            rpcIdFingerprint: idFingerprint,
            actionId: ledger.currentActionId,
            routeSocketId,
            threadIdFingerprint: typeof frame.params?.threadId === "string" ? sha256(frame.params.threadId).slice(0, 16) : null,
            turnIdFingerprint: typeof frame.params?.turnId === "string" ? sha256(frame.params.turnId).slice(0, 16) : null,
            receiptRequestIdentity,
            ...routeInfo,
          });
          ledger.pendingRpcMethodCounts[frame.method] = (ledger.pendingRpcMethodCounts[frame.method] ?? 0) + 1;
          if (frame.method === "turn/start" && delayControl.turnStartErrorFixture === true) {
            const request = pendingRpc.get(String(frame.id));
            const errorFrame = createTurnStartErrorFixtureFrame(frame);
            const receivedAt = performance.now();
            const receivedAtEpochMs = epochNow();
            const configuredDelayMs = sumResponseDelayMs(
              delayControl.methodResponseHoldMs?.["turn/start"] ?? 0,
            );
            const eligibleAt = receivedAt + configuredDelayMs;
            ledger.pendingWebSocketDeliveries += 1;
            deliverQueue = deliverQueue
              .then(async () => {
                if (configuredDelayMs > 0) await waitUntilPerformanceDeadline(eligibleAt);
                socket.send(JSON.stringify(errorFrame));
                const deliveredAt = performance.now();
                const appliedDelayMs = round(deliveredAt - receivedAt);
                const fixtureEvent = {
                  scenario: delayControl.scenarioId ?? "unspecified",
                  kind: "turn-start-error-fixture",
                  responseSource: "test-generated request-id-correlated JSON-RPC error at Playwright WebSocket route",
                  requestIdFingerprint: request.rpcIdFingerprint,
                  clientMessageIdFingerprint: typeof frame.params?.clientMessageId === "string" ? sha256(frame.params.clientMessageId).slice(0, 16) : null,
                  threadIdFingerprint: request.threadIdFingerprint,
                  routeSocketId,
                  requestIdPreserved: errorFrame.id === frame.id,
                  errorCode: errorFrame.error.code,
                  configuredDelayMs,
                  appliedDelayMs,
                  stage: request.stage,
                  atMs: round(deliveredAt),
                };
                ledger.websocketFrames += 1;
                ledger.faultFixtureEvents.push(fixtureEvent);
                ledger.websocketResponsePathDelays.push({
                  method: "turn/start",
                  configuredDelayMs,
                  appliedDelayMs,
                  isRpcResponse: true,
                  rpcIdFingerprint: request.rpcIdFingerprint,
                  actionId: request.actionId,
                  routeSocketId,
                  ...routeInfo,
                  receivedAtEpochMs: round(receivedAtEpochMs),
                  forwardedAtEpochMs: round(epochNow()),
                  stage: request.stage,
                  scenario: delayControl.scenarioId ?? null,
                  responseSource: "test-generated request-id-correlated JSON-RPC error; bypasses KCODER_STUDIO_MOCK runMock",
                });
                ledger.rpc.push({
                  method: "turn/start",
                  rpcIdFingerprint: request.rpcIdFingerprint,
                  actionId: request.actionId,
                  routeSocketId,
                  ...routeInfo,
                  durationMs: round(deliveredAt - request.sentAt),
                  configuredDelayMs,
                  methodResponseHoldMs: configuredDelayMs,
                  appliedMethodResponseHoldMs: appliedDelayMs,
                  responsePathAppliedDelayMs: appliedDelayMs,
                  requestSentAtEpochMs: round(request.sentAtEpochMs),
                  responseReceivedAtEpochMs: round(receivedAtEpochMs),
                  responseForwardedAtEpochMs: round(epochNow()),
                  ok: false,
                  errorCode: errorFrame.error.code,
                  responseSource: fixtureEvent.responseSource,
                });
                ledger.methodResponseHolds.push({
                  method: "turn/start",
                  configuredHoldMs: configuredDelayMs,
                  measuredHoldMs: appliedDelayMs,
                  ok: false,
                  responseSource: "test-generated JSON-RPC error fixture",
                  scenario: delayControl.scenarioId ?? null,
                  stage: request.stage,
                });
                ledger.rpcEvents.push({
                  direction: "response-forwarded",
                  method: "turn/start",
                  rpcIdFingerprint: request.rpcIdFingerprint,
                  atMs: round(deliveredAt),
                  atEpochMs: round(epochNow()),
                  stage: request.stage,
                  actionId: request.actionId,
                  routeSocketId,
                  ...routeInfo,
                  ok: false,
                  errorCode: errorFrame.error.code,
                  responseSource: "test-generated JSON-RPC error fixture",
                });
                pendingRpc.delete(String(frame.id));
                ledger.pendingRpcMethodCounts["turn/start"] = Math.max(0, (ledger.pendingRpcMethodCounts["turn/start"] ?? 1) - 1);
              })
              .catch(() => {
                ledger.websocketForwardErrors += 1;
                pendingRpc.delete(String(frame.id));
                ledger.pendingRpcMethodCounts["turn/start"] = Math.max(0, (ledger.pendingRpcMethodCounts["turn/start"] ?? 1) - 1);
              })
              .finally(() => { ledger.pendingWebSocketDeliveries = Math.max(0, ledger.pendingWebSocketDeliveries - 1); });
            return;
          }
          if (frame.method === "turn/receipt/read" && delayControl.receiptFixture) {
            const request = pendingRpc.get(String(frame.id));
            const receipt = delayControl.receiptFixture.read(frame.params, delayControl.receiptScope, routeSocketId);
            const response = { jsonrpc: frame.jsonrpc || "2.0", id: frame.id, result: { receipt } };
            socket.send(JSON.stringify(response));
            ledger.rpc.push({
              method: frame.method,
              rpcIdFingerprint: idFingerprint,
              actionId: ledger.currentActionId,
              routeSocketId,
              ...routeInfo,
              durationMs: round(performance.now() - request.sentAt),
              configuredDelayMs: 0,
              methodResponseHoldMs: 0,
              responsePathAppliedDelayMs: 0,
              responseSource: "in-memory fixture populated from observed isolated mock turn/start response",
              ok: Boolean(receipt),
            });
            ledger.rpcEvents.push({
              direction: "response-forwarded",
              method: frame.method,
              rpcIdFingerprint: idFingerprint,
              atMs: round(performance.now()),
              atEpochMs: round(epochNow()),
              stage: ledger.currentStage,
              actionId: ledger.currentActionId,
              routeSocketId,
              ...routeInfo,
              responseSource: "in-memory-test-fixture",
            });
            ledger.faultFixtureEvents.push({
              scenario: delayControl.scenarioId ?? "unspecified",
              kind: "turn-receipt-readback",
              exactObservedAcceptanceMatched: Boolean(receipt),
              receiptScopeFingerprint: receipt ? delayControl.receiptFixture.summary().acceptedIdentityFingerprints.find(row => row.threadIdFingerprint === sha256(frame.params?.threadId).slice(0, 16) && row.clientMessageIdFingerprint === sha256(frame.params?.clientMessageId).slice(0, 16))?.scopeFingerprint ?? null : null,
              threadIdFingerprint: typeof frame.params?.threadId === "string" ? sha256(frame.params.threadId).slice(0, 16) : null,
              receiptClientMessageIdFingerprint: typeof frame.params?.clientMessageId === "string" ? sha256(frame.params.clientMessageId).slice(0, 16) : null,
              routeSocketId,
              receiptFixtureKind: "in-memory isolated mock only; not durable Rust app-server evidence",
            });
            pendingRpc.delete(String(frame.id));
            ledger.pendingRpcMethodCounts[frame.method] = Math.max(0, (ledger.pendingRpcMethodCounts[frame.method] ?? 1) - 1);
            return;
          }
        }
      }
      upstream.send(raw);
    });
    upstream.onMessage(async raw => {
      const receivedAt = performance.now();
      const receivedAtEpochMs = epochNow();
      let frame = parseFrame(raw);
      const request = frame?.id !== undefined ? pendingRpc.get(String(frame.id)) : null;
      const method = request?.method ?? (typeof frame?.method === "string" ? frame.method : "notification");
      if (delayControl.scenarioId && ["turn/started", "turn/completed"].includes(frame?.method)) {
        const params = frame.params ?? {};
        ledger.faultFixtureEvents.push({
          scenario: delayControl.scenarioId,
          kind: "turn-lifecycle-upstream-frame",
          method: frame.method,
          threadIdFingerprint: typeof params.threadId === "string" ? sha256(params.threadId).slice(0, 16) : null,
          turnIdFingerprint: typeof params.turnId === "string" ? sha256(params.turnId).slice(0, 16) : null,
          turnStatus: typeof params.turn?.status === "string" ? params.turn.status : null,
          routeSocketId,
          atMs: round(receivedAt),
          stage: ledger.currentStage,
          source: "upstream-mock-gateway-frame",
        });
      }
      if (delayControl.scenarioId && request?.method === "turn/interrupt") {
        ledger.faultFixtureEvents.push({
          scenario: delayControl.scenarioId,
          kind: "turn-interrupt-upstream-response",
          interrupted: frame?.result?.interrupted === true,
          rpcIdFingerprint: request.rpcIdFingerprint,
          threadIdFingerprint: request.threadIdFingerprint,
          turnIdFingerprint: request.turnIdFingerprint,
          routeSocketId,
          atMs: round(receivedAt),
          stage: ledger.currentStage,
          source: "upstream-mock-gateway-response",
        });
      }
      if (delayControl.threadModelFixture && request && ["thread/read", "thread/resume"].includes(request.method) && frame?.result?.thread) {
        frame = {
          ...frame,
          result: {
            ...frame.result,
            thread: { ...frame.result.thread, model: "MiniMax-M3", modelProvider: "kunlunmeta" },
          },
        };
        ledger.faultFixtureEvents.push({
          scenario: delayControl.scenarioId ?? "unspecified",
          kind: "typed-thread-model-fixture",
          method: request.method,
          modelFixture: "mock-minimax from KCODER_STUDIO_MOCK catalog",
          routeSocketId,
        });
      }
      if (request?.method === "initialize" && delayControl.testCapabilities && frame?.result?.capabilities) {
        frame = {
          ...frame,
          result: {
            ...frame.result,
            capabilities: {
              ...frame.result.capabilities,
              experimental: {
                ...frame.result.capabilities.experimental,
                ...delayControl.testCapabilities,
              },
            },
          },
        };
      }
      if (request?.method === "turn/start" && delayControl.receiptFixture) {
        request.receiptAcceptedAtMockResponse = delayControl.receiptFixture.observeTurnStartResponse(request.receiptRequestIdentity, frame, routeSocketId);
      }
      const responseJitter = delayControl.responseJitter?.next("rpc", method) ?? { sampleIndex: null, delayMs: 0 };
      const configuredDelayMs = sumResponseDelayMs(
        delayControl.delayMs ?? 0,
        delayControl.methodDelayMs?.[method] ?? 0,
        responseJitter.delayMs,
      );
      const dropResponse = Boolean(request)
        && delayControl.dropFirstResponseForMethod === method
        && !ledger.injectedWebSocketResponseDrops.some(row => row.scenario === delayControl.scenarioId && row.method === method);
      if (dropResponse) {
        ledger.injectedWebSocketResponseDrops.push({
          scenario: delayControl.scenarioId ?? "unspecified",
          method,
          rpcIdFingerprint: request.rpcIdFingerprint,
          responseReceivedAtEpochMs: round(receivedAtEpochMs),
          acceptedObservedFromMockGateway: method === "turn/start" && request.receiptAcceptedAtMockResponse === true,
          threadIdFingerprint: request.receiptRequestIdentity ? sha256(request.receiptRequestIdentity.threadId).slice(0, 16) : null,
          clientMessageIdFingerprint: request.receiptRequestIdentity ? sha256(request.receiptRequestIdentity.clientMessageId).slice(0, 16) : null,
          receiptScopeFingerprint: request.receiptRequestIdentity?.scopeFingerprint ?? null,
          routeSocketId,
          responseForwarded: false,
          transportLayer: "single JSON-RPC response dropped in Playwright WebSocket route; not IP/TCP packet loss",
        });
        ledger.rpc.push({
          method,
          rpcIdFingerprint: request.rpcIdFingerprint,
          actionId: request.actionId,
          routeSocketId,
          ...routeInfo,
          durationMs: round(performance.now() - request.sentAt),
          configuredDelayMs,
          responsePathAppliedDelayMs: null,
          responseReceivedAtEpochMs: round(receivedAtEpochMs),
          responseForwardedAtEpochMs: null,
          responseDroppedByFixture: true,
          ok: !frame?.error,
        });
        ledger.rpcEvents.push({
          direction: "response-dropped",
          method,
          rpcIdFingerprint: request.rpcIdFingerprint,
          atMs: round(performance.now()),
          atEpochMs: round(epochNow()),
          stage: ledger.currentStage,
          actionId: request.actionId,
          routeSocketId,
          ...routeInfo,
        });
        pendingRpc.delete(String(frame.id));
        ledger.pendingRpcMethodCounts[method] = Math.max(0, (ledger.pendingRpcMethodCounts[method] ?? 1) - 1);
        if (delayControl.closeAfterDroppedResponse) {
          ledger.faultFixtureEvents.push({ scenario: delayControl.scenarioId ?? "unspecified", kind: "socket-closed-after-dropped-response", method });
          recordRoutedWebSocketCloseInvocation(ledger, routeSocketId, { code: 1012, reason: "isolated test reconnect", stage: ledger.currentStage, actionId: ledger.currentActionId });
          await socket.close({ code: 1012, reason: "isolated test reconnect" });
        }
        return;
      }
      // The WSS application delay starts when the upstream response frame arrives.
      const eligibleAt = receivedAt + configuredDelayMs;
      ledger.pendingWebSocketDeliveries += 1;
      const deliver = async appliedMethodResponseHoldMs => {
        ledger.websocketFrames += 1;
        if (configuredDelayMs > 0) await waitUntilPerformanceDeadline(eligibleAt);
        socket.send(frame && JSON.stringify(frame) !== String(raw) ? JSON.stringify(frame) : raw);
        const deliveredAt = performance.now();
        if (delayControl.scenarioId && ["turn/started", "turn/completed"].includes(frame?.method)) {
          const params = frame.params ?? {};
          ledger.faultFixtureEvents.push({
            scenario: delayControl.scenarioId,
            kind: "turn-lifecycle-frame",
            method: frame.method,
            threadIdFingerprint: typeof params.threadId === "string" ? sha256(params.threadId).slice(0, 16) : null,
            turnIdFingerprint: typeof params.turnId === "string" ? sha256(params.turnId).slice(0, 16) : null,
            turnStatus: typeof params.turn?.status === "string" ? params.turn.status : null,
            routeSocketId,
            atMs: round(deliveredAt),
            stage: ledger.currentStage,
            source: "route-forwarded-to-browser",
          });
        }
        const appliedDelayMs = round(deliveredAt - receivedAt);
        ledger.websocketResponsePathDelays.push({
          method,
          configuredDelayMs,
          jitterSampleIndex: responseJitter.sampleIndex,
          jitterDelayMs: responseJitter.delayMs,
          appliedDelayMs,
          isRpcResponse: Boolean(request),
          rpcIdFingerprint: request?.rpcIdFingerprint ?? (frame?.id !== undefined ? rpcIdFingerprint(frame.id) : null),
          actionId: request?.actionId ?? ledger.currentActionId,
          routeSocketId,
          ...routeInfo,
          receivedAtEpochMs: round(receivedAtEpochMs),
          forwardedAtEpochMs: round(epochNow()),
          stage: ledger.currentStage,
          scenario: delayControl.scenarioId ?? null,
        });
        if (request) {
          ledger.rpc.push({
            method,
            rpcIdFingerprint: request.rpcIdFingerprint,
            actionId: request.actionId,
            routeSocketId,
            ...routeInfo,
            durationMs: round(performance.now() - request.sentAt),
            configuredDelayMs,
            methodResponseHoldMs: delayControl.methodResponseHoldMs?.[method] ?? 0,
            appliedMethodResponseHoldMs,
            responsePathAppliedDelayMs: appliedDelayMs,
            requestSentAtEpochMs: round(request.sentAtEpochMs),
            responseReceivedAtEpochMs: round(receivedAtEpochMs),
            responseForwardedAtEpochMs: round(epochNow()),
            ok: !frame?.error,
            timingBoundary: "browser RPC request to delayed response frame delivery through loopback Gateway; not physical RTT",
          });
          if ((delayControl.methodResponseHoldMs?.[method] ?? 0) > 0) ledger.methodResponseHolds.push({
            method,
            configuredHoldMs: delayControl.methodResponseHoldMs[method],
            measuredHoldMs: appliedMethodResponseHoldMs,
            ok: !frame?.error,
            scenario: delayControl.scenarioId ?? null,
            stage: request.stage,
          });
          pendingRpc.delete(String(frame.id));
          ledger.pendingRpcMethodCounts[method] = Math.max(0, (ledger.pendingRpcMethodCounts[method] ?? 1) - 1);
          ledger.rpcEvents.push({
            direction: "response-forwarded",
            method,
            rpcIdFingerprint: request.rpcIdFingerprint,
            atMs: round(performance.now()),
            atEpochMs: round(epochNow()),
            stage: ledger.currentStage,
            actionId: request.actionId,
            routeSocketId,
            ...routeInfo,
          });
        }
        if (request && delayControl.disconnectAfterMethodResponse === method) {
          const alreadyClosed = ledger.faultFixtureEvents.some(row => row.scenario === delayControl.scenarioId && row.kind === "socket-closed-after-response");
          if (!alreadyClosed) {
            ledger.faultFixtureEvents.push({ scenario: delayControl.scenarioId ?? "unspecified", kind: "socket-closed-after-response", method });
            recordRoutedWebSocketCloseInvocation(ledger, routeSocketId, { code: 1012, reason: "isolated test reconnect", stage: ledger.currentStage, actionId: ledger.currentActionId });
            await socket.close({ code: 1012, reason: "isolated test reconnect" });
          }
        }
      };
      const methodResponseHoldMs = sumResponseDelayMs(delayControl.methodResponseHoldMs?.[method] ?? 0);
      if (methodResponseHoldMs > 0 && request) {
        // Keep the original hold duration boundary at upstream-frame receipt.
        const methodResponseHoldDeadline = receivedAt + methodResponseHoldMs;
        const timer = setTimeout(() => {
          methodResponseHoldTimers.delete(timer);
          void (async () => {
            await waitUntilPerformanceDeadline(methodResponseHoldDeadline);
            const measuredHoldMs = round(performance.now() - receivedAt);
            await deliver(measuredHoldMs);
          })()
            .catch(() => { ledger.websocketForwardErrors += 1; })
            .finally(() => { ledger.pendingWebSocketDeliveries = Math.max(0, ledger.pendingWebSocketDeliveries - 1); });
        }, Math.max(0, methodResponseHoldDeadline - performance.now()));
        methodResponseHoldTimers.add(timer);
        return;
      }
      deliverQueue = deliverQueue
        .then(() => deliver(0))
        .catch(() => { ledger.websocketForwardErrors += 1; })
        .finally(() => { ledger.pendingWebSocketDeliveries = Math.max(0, ledger.pendingWebSocketDeliveries - 1); });
    });
    socket.onClose(() => {
      ledger.routedWebSocketCloseEvents.push({
        routeSocketId,
        atMs: round(performance.now()),
        atEpochMs: round(epochNow()),
        stage: ledger.currentStage,
        actionId: ledger.currentActionId,
        pendingRequests: [...pendingRpc.values()].map(request => ({
          method: request.method,
          rpcIdFingerprint: request.rpcIdFingerprint,
          routeSocketId,
          startedAtEpochMs: round(request.sentAtEpochMs),
          stage: request.stage,
          actionId: request.actionId,
        })),
      });
      for (const request of pendingRpc.values()) {
        ledger.pendingRpcMethodCounts[request.method] = Math.max(0, (ledger.pendingRpcMethodCounts[request.method] ?? 1) - 1);
      }
      pendingRpc.clear();
    });
  });
}

async function waitForGatewayRpcQuiescence(network, timeoutMs = 30_000, quietMs = 200) {
  const startedAt = performance.now();
  let lastActivity = gatewayActivityFingerprint(network);
  let quietStartedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const currentActivity = gatewayActivityFingerprint(network);
    const pending = pendingGatewayActivity(network);
    if (currentActivity !== lastActivity) {
      lastActivity = currentActivity;
      quietStartedAt = performance.now();
    }
    if (pending.total === 0 && performance.now() - quietStartedAt >= quietMs) {
      const report = {
        status: "DRAINED",
        elapsedMs: round(performance.now() - startedAt),
        quietWindowMs: quietMs,
        pendingAtReturn: pending,
        activityFingerprint: currentActivity,
        atEpochMs: round(epochNow()),
      };
      network.quiescenceWaits.push(report);
      return report;
    }
    await delay(25);
  }
  const pendingAtTimeout = pendingGatewayActivity(network);
  const report = {
    status: "TIMEOUT",
    elapsedMs: round(performance.now() - startedAt),
    quietWindowMs: quietMs,
    pendingAtReturn: pendingAtTimeout,
    activityFingerprint: gatewayActivityFingerprint(network),
    atEpochMs: round(epochNow()),
  };
  network.quiescenceWaits.push(report);
  throw new Error(`Gateway response paths did not drain within ${timeoutMs}ms: ${JSON.stringify(pendingAtTimeout)}`);
}

function pendingGatewayActivity(network) {
  const pendingRpc = Object.values(network.pendingRpcMethodCounts).reduce((sum, count) => sum + count, 0);
  const pendingHttp = network.pendingHttpResponses;
  const pendingWebSocketDeliveries = network.pendingWebSocketDeliveries;
  return {
    httpResponses: pendingHttp,
    websocketDeliveries: pendingWebSocketDeliveries,
    rpcResponses: pendingRpc,
    total: pendingHttp + pendingWebSocketDeliveries + pendingRpc,
  };
}

function gatewayActivityFingerprint(network) {
  return [
    network.rpcEvents.length,
    network.rpc.length,
    network.http.length,
    network.httpResponsePathDelays.length,
    network.websocketFrames,
    network.websocketResponsePathDelays.length,
    network.browserFrames.length,
    network.routedWebSocketCloseEvents.length,
  ].join(":");
}

function snapshotNetworkEvidence(network) {
  const { requestStarts: _requestStarts, ...evidence } = network;
  const snapshot = JSON.parse(JSON.stringify(evidence));
  return deepFreeze(snapshot);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function createNetworkLedger() {
  return {
    pendingHttpResponses: 0,
    pendingWebSocketDeliveries: 0,
    quiescenceWaits: [],
    http: [],
    rpc: [],
    httpRouteRequests: [],
    httpRouteRequestSequence: 0,
    httpResponsePathDelays: [],
    websocketResponsePathDelays: [],
    websocketFrames: 0,
    websocketForwardErrors: 0,
    methodResponseHolds: [],
    injectedHttpStatuses: [],
    injectedWebSocketResponseDrops: [],
    faultFixtureEvents: [],
    rpcMethodCounts: Object.create(null),
    pendingRpcMethodCounts: Object.create(null),
    rpcEvents: [],
    browserFrames: [],
    browserFrameMethodCounts: Object.create(null),
    browserWebSocketPaths: [],
    browserWebSocketConnections: [],
    browserSocketSequence: 0,
    applicationPageSequence: 0,
    applicationWebSocketConnections: [],
    applicationWebSocketFrames: [],
    applicationWebSocketCaptureHealth: [],
    routedWebSocketConnections: [],
    routedWebSocketCloseEvents: [],
    routedWebSocketCloseInvocations: [],
    routedSocketSequence: 0,
    navigationSampleSequence: 0,
    currentStage: "startup",
    currentActionId: null,
    currentAction: null,
    drawerClosedListChecks: [],
    drawerCloseListChecks: [],
    failedRequests: Object.create(null),
    requestStarts: new WeakMap(),
  };
}

function summarizeObservations(observations) {
  const groups = new Map();
  for (const observation of observations) {
    const key = `${observation.action}|${observation.cacheClass}|${observation.delayMs}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const [action, cacheClass, delayText] = key.split("|");
    const values = entries.filter(entry => entry.ok && Number.isFinite(entry.durationMs)).map(entry => entry.durationMs).sort((a, b) => a - b);
    return {
      action,
      cacheClass,
      configuredApplicationDelayMs: Number(delayText),
      sampleCount: entries.length,
      successCount: entries.filter(entry => entry.ok).length,
      errorCount: entries.filter(entry => !entry.ok).length,
      errorRate: entries.length ? Number((entries.filter(entry => !entry.ok).length / entries.length).toFixed(4)) : 0,
      percentileEligibility: values.length >= DEFAULT_SAMPLES ? "30+ samples" : "SMOKE_ONLY",
      p50Ms: values.length >= DEFAULT_SAMPLES ? percentile(values, 0.50) : null,
      p95Ms: values.length >= DEFAULT_SAMPLES ? percentile(values, 0.95) : null,
      maxMs: values.length ? values.at(-1) : null,
    };
  }).sort((a, b) => a.configuredApplicationDelayMs - b.configuredApplicationDelayMs || a.action.localeCompare(b.action) || a.cacheClass.localeCompare(b.cacheClass));
}

function scenarioStatus(rows, scenario) {
  return rows.find(row => row.scenario === scenario)?.status ?? "NOT_RUN";
}

function summarizeNetwork(network) {
  const group = rows => {
    const groups = new Map();
    for (const row of rows) {
      const key = row.path || row.method;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return [...groups.entries()].map(([key, entries]) => {
      const values = entries.map(entry => entry.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
      return {
        key,
        samples: entries.length,
        ...(refreshSingleSampleMode ? { percentileEligibility: refreshCoverageMode, percentilesReported: false } : { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) }),
        maxMs: values.length ? values.at(-1) : null,
      };
    });
  };
  return {
      httpByPath: group(network.http),
      httpRouteRequests: network.httpRouteRequests,
      httpResponsePathResponses: network.httpResponsePathDelays.map(item => ({
        routeRequestOrdinal: item.routeRequestOrdinal,
        apiPath: item.apiPath,
        configuredDelayMs: item.configuredDelayMs,
        jitterDelayMs: item.jitterDelayMs,
        appliedDelayMs: item.appliedDelayMs,
        status: item.status,
        stage: item.stage,
        scenario: item.scenario,
      })),
    rpcByMethod: group(network.rpc.map(row => ({ ...row, path: row.method || row.path }))),
    rpcTransactions: network.rpc,
    httpResponsePathFrames: network.httpResponsePathDelays.length,
    httpAppliedDelayByPath: group(network.httpResponsePathDelays.map(row => ({ path: row.path, durationMs: row.appliedDelayMs, configuredDelayMs: row.configuredDelayMs }))),
    websocketResponseFrames: network.websocketFrames,
    websocketResponsePathFrames: network.websocketResponsePathDelays.length,
    websocketResponseDelayDistributionMs: distribution(network.websocketResponsePathDelays.map(row => row.configuredDelayMs)),
    websocketAppliedDelayByMethod: group(network.websocketResponsePathDelays.map(row => ({ method: row.method, durationMs: row.appliedDelayMs, configuredDelayMs: row.configuredDelayMs }))),
    websocketResponsePathEvents: network.websocketResponsePathDelays,
    injectedHttpStatuses: network.injectedHttpStatuses,
    injectedWebSocketResponseDrops: network.injectedWebSocketResponseDrops,
    faultFixtureEvents: network.faultFixtureEvents,
    rpcMethodCounts: network.rpcMethodCounts,
    browserFrameMethodCounts: network.browserFrameMethodCounts,
    browserWebSocketPaths: network.browserWebSocketPaths,
    browserWebSocketConnections: network.browserWebSocketConnections,
    routedWebSocketConnections: network.routedWebSocketConnections,
    routedWebSocketCloseEvents: network.routedWebSocketCloseEvents,
    routedWebSocketCloseInvocations: network.routedWebSocketCloseInvocations,
    applicationWebSocketConnections: network.applicationWebSocketConnections,
    applicationWebSocketFrames: network.applicationWebSocketFrames,
    applicationWebSocketCaptureHealth: network.applicationWebSocketCaptureHealth,
    browserWebSocketConnectionCount: network.browserWebSocketConnections.length,
    routedWebSocketConnectionCount: network.routedWebSocketConnections.length,
    browserFrames: network.browserFrames,
    pendingRpcMethodCounts: network.pendingRpcMethodCounts,
    pendingHttpResponses: network.pendingHttpResponses,
    pendingWebSocketDeliveries: network.pendingWebSocketDeliveries,
    quiescenceWaits: network.quiescenceWaits,
    rpcEvents: network.rpcEvents,
    drawerClosedListChecks: network.drawerClosedListChecks,
    drawerCloseListChecks: network.drawerCloseListChecks,
    failedRequests: network.failedRequests,
    websocketForwardErrors: network.websocketForwardErrors,
  };
}

function correlateRpcFrames(network) {
  const browserRequests = network.applicationWebSocketFrames.filter(frame => frame.direction === "sent" && frame.hasId && frame.method);
  const routeRequests = network.rpcEvents.filter(event => event.direction === "request" && event.hasId && event.method);
  const socketPairing = pairApplicationAndRouteSockets(
    network.applicationWebSocketConnections,
    network.routedWebSocketConnections,
    network.applicationWebSocketFrames,
    network.rpcEvents,
  );
  const socketPairs = socketPairing.pairs;
  const routeSocketByApplicationSocket = new Map(socketPairs.map(pair => [`${pair.applicationPageId}:${pair.applicationSocketId}`, pair.routeSocketId]));
  const requestKey = (row, routeSocketId) => `${routeSocketId}|${row.method}|${row.rpcIdFingerprint}`;
  const routeRequestCandidates = new Map();
  routeRequests.forEach((event, index) => {
    const key = requestKey(event, event.routeSocketId);
    if (!routeRequestCandidates.has(key)) routeRequestCandidates.set(key, []);
    routeRequestCandidates.get(key).push({ index, event, used: false });
  });
  const matchedRequests = [];
  const unmatchedBrowserRequests = [];
  for (const browserFrame of browserRequests) {
    const routeSocketId = routeSocketByApplicationSocket.get(`${browserFrame.pageId}:${browserFrame.socketId}`);
    const candidates = routeSocketId === undefined ? [] : routeRequestCandidates.get(requestKey(browserFrame, routeSocketId)) ?? [];
    let best = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (candidate.used) continue;
      const routeEvent = candidate.event;
      const delta = Math.abs(browserFrame.atEpochMs - routeEvent.atEpochMs);
      if (delta < bestDelta) {
        best = candidate;
        bestDelta = delta;
      }
    }
    if (!best || bestDelta > 2_000) {
      unmatchedBrowserRequests.push({
        method: browserFrame.method,
        rpcIdFingerprint: browserFrame.rpcIdFingerprint,
        applicationPageId: browserFrame.pageId,
        applicationSocketId: browserFrame.socketId,
        routeSocketId: routeSocketId ?? null,
        browserAtEpochMs: browserFrame.atEpochMs,
      });
      continue;
    }
    best.used = true;
    matchedRequests.push({
      method: browserFrame.method,
      rpcIdFingerprint: browserFrame.rpcIdFingerprint,
      browserActionId: best.event.actionId,
      routeActionId: best.event.actionId,
      applicationPageId: browserFrame.pageId,
      applicationSocketId: browserFrame.socketId,
      routeSocketId: best.event.routeSocketId,
      browserAtEpochMs: browserFrame.atEpochMs,
      routeAtEpochMs: best.event.atEpochMs,
      routeMinusBrowserMs: round(best.event.atEpochMs - browserFrame.atEpochMs),
    });
  }
  const unmatchedRouteRequests = routeRequests.flatMap((event, index) => routeRequestCandidates.get(requestKey(event, event.routeSocketId))?.find(candidate => candidate.index === index)?.used ? [] : [{
    method: event.method,
    rpcIdFingerprint: event.rpcIdFingerprint,
    actionId: event.actionId,
    routeSocketId: event.routeSocketId,
    routeAtEpochMs: event.atEpochMs,
  }]);
  const routeResponses = network.rpc.filter(row => row.rpcIdFingerprint && Number.isFinite(row.responseForwardedAtEpochMs));
  const delayedRouteResponses = routeResponses.filter(row => row.configuredDelayMs > 0);
  const browserResponses = network.applicationWebSocketFrames.filter(frame => frame.direction === "received" && frame.hasId && (frame.hasResult || frame.hasError));
  const responseCandidates = new Map();
  browserResponses.forEach((frame, index) => {
    const routeSocketId = routeSocketByApplicationSocket.get(`${frame.pageId}:${frame.socketId}`);
    if (routeSocketId === undefined) return;
    const key = `${routeSocketId}|${frame.rpcIdFingerprint}`;
    if (!responseCandidates.has(key)) responseCandidates.set(key, []);
    responseCandidates.get(key).push({ index, frame, routeSocketId, used: false });
  });
  const matchedRouteResponses = [];
  const matchedDelayedResponses = [];
  const unmatchedRouteResponses = [];
  const matchedBrowserResponseIndexes = new Set();
  for (const routeResponse of routeResponses) {
    const responseKey = `${routeResponse.routeSocketId}|${routeResponse.rpcIdFingerprint}`;
    let best = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const candidate of responseCandidates.get(responseKey) ?? []) {
      if (candidate.used) continue;
      const browserFrame = candidate.frame;
      const delta = Math.abs(browserFrame.atEpochMs - routeResponse.responseForwardedAtEpochMs);
      if (delta < bestDelta) {
        best = candidate;
        bestDelta = delta;
      }
    }
    const maxClockSkewMs = 2_000;
    if (!best || bestDelta > maxClockSkewMs) {
      unmatchedRouteResponses.push({
        method: routeResponse.method,
        rpcIdFingerprint: routeResponse.rpcIdFingerprint,
        actionId: routeResponse.actionId,
        routeSocketId: routeResponse.routeSocketId,
        configuredDelayMs: routeResponse.configuredDelayMs,
        forwardedAtEpochMs: routeResponse.responseForwardedAtEpochMs,
      });
      continue;
    }
    best.used = true;
    matchedBrowserResponseIndexes.add(best.index);
    const match = {
      method: routeResponse.method,
      rpcIdFingerprint: routeResponse.rpcIdFingerprint,
      actionId: routeResponse.actionId,
      routeSocketId: routeResponse.routeSocketId,
      applicationPageId: best.frame.pageId,
      applicationSocketId: best.frame.socketId,
      configuredDelayMs: routeResponse.configuredDelayMs,
      routeForwardedAtEpochMs: routeResponse.responseForwardedAtEpochMs,
      browserReceivedAtEpochMs: best.frame.atEpochMs,
    nativeObserverMinusRouteForwardedMs: round(best.frame.atEpochMs - routeResponse.responseForwardedAtEpochMs),
    };
    matchedRouteResponses.push(match);
    if (routeResponse.configuredDelayMs > 0) matchedDelayedResponses.push(match);
  }
  const unmatchedBrowserResponses = browserResponses.flatMap((frame, index) => matchedBrowserResponseIndexes.has(index) ? [] : [{
    method: frame.method,
    rpcIdFingerprint: frame.rpcIdFingerprint,
    applicationPageId: frame.pageId,
    applicationSocketId: frame.socketId,
    routeSocketId: routeSocketByApplicationSocket.get(`${frame.pageId}:${frame.socketId}`) ?? null,
    receivedAtEpochMs: frame.atEpochMs,
  }]);
  const countByMethod = rows => Object.fromEntries([...new Set(rows.map(row => row.method))].sort().map(method => [method, rows.filter(row => row.method === method).length]));
  const percentage = (matched, total) => total === 0 ? null : Number((matched * 100 / total).toFixed(1));
  const preShimNativeObserverBeforeForward = matchedDelayedResponses.filter(row => row.nativeObserverMinusRouteForwardedMs < -50);
  const preShimNativeObserverOffsetByConfiguredDelayMs = Object.fromEntries([...new Set(matchedDelayedResponses.map(row => row.configuredDelayMs))].sort((a, b) => a - b).map(delayMs => {
    const rows = matchedDelayedResponses.filter(row => row.configuredDelayMs === delayMs);
    return [delayMs, {
      count: rows.length,
      beforeForwardCount: rows.filter(row => row.nativeObserverMinusRouteForwardedMs < -50).length,
      offsetsMs: rows.map(row => row.nativeObserverMinusRouteForwardedMs),
    }];
  }));
  return {
    browserRequestCount: browserRequests.length,
    routeRequestCount: routeRequests.length,
    matchedRequestCount: matchedRequests.length,
    requestCoveragePercent: percentage(matchedRequests.length, browserRequests.length),
    browserRequestsByMethod: countByMethod(browserRequests),
    routeRequestsByMethod: countByMethod(routeRequests),
    unmatchedBrowserRequestsByMethod: countByMethod(unmatchedBrowserRequests),
    unmatchedRouteRequestsByMethod: countByMethod(unmatchedRouteRequests),
    matchedRequests,
    unmatchedBrowserRequests,
    unmatchedRouteRequests,
    browserResponseCount: browserResponses.length,
    routeResponseCount: routeResponses.length,
    matchedRouteResponseCount: matchedRouteResponses.length,
    unmatchedRouteResponses,
    unmatchedBrowserResponses,
    delayedRouteResponseCount: delayedRouteResponses.length,
    matchedDelayedResponseCount: matchedDelayedResponses.length,
    responseCoveragePercent: percentage(matchedRouteResponses.length, routeResponses.length),
    browserResponseCoveragePercent: percentage(matchedRouteResponses.length, browserResponses.length),
    delayedResponseCoveragePercent: percentage(matchedDelayedResponses.length, delayedRouteResponses.length),
    matchedDelayedResponses,
    preShimNativeObserverBeforeForwardCount: preShimNativeObserverBeforeForward.length,
    preShimNativeObserverOffsetByConfiguredDelayMs,
    applicationDispatchReceiptObserved: false,
    responseObservationLayer: "Playwright-captured native WebSocket transport before WebSocketMock dispatch",
    unmatchedDelayedResponses: unmatchedRouteResponses.filter(row => row.configuredDelayMs > 0),
    socketPairCount: socketPairs.length,
    applicationWebSocketCount: network.applicationWebSocketConnections.length,
    routedWebSocketCount: network.routedWebSocketConnections.length,
    socketPairs,
    ambiguousSocketGroups: socketPairing.ambiguousGroups,
    unpairedApplicationSockets: socketPairing.unpairedApplicationSockets,
    unpairedRouteSockets: socketPairing.unpairedRouteSockets,
    playwrightTransportObserverResponseCount: network.browserFrames.filter(frame => frame.direction === "received" && frame.hasId && (frame.hasResult || frame.hasError)).length,
  };
}

function pairApplicationAndRouteSockets(applicationSockets, routeSockets, applicationFrames, routeEvents) {
  const routeMetadataKey = row => JSON.stringify([
    row.path,
    row.serverFingerprint,
    row.channelFingerprint,
    row.workspaceFingerprint,
  ]);
  const appSequence = new Map();
  for (const socket of applicationSockets) {
    const rows = applicationFrames
      .filter(frame => frame.pageId === socket.pageId && frame.socketId === socket.socketId && frame.direction === "sent" && frame.method)
      .sort((a, b) => a.atEpochMs - b.atEpochMs)
      .map(frame => `${frame.method}|${frame.rpcIdFingerprint ?? "-"}`);
    appSequence.set(`${socket.pageId}:${socket.socketId}`, rows);
  }
  const routeSequence = new Map();
  for (const socket of routeSockets) {
    const rows = routeEvents
      .filter(event => event.routeSocketId === socket.id && event.direction === "request" && event.method)
      .sort((a, b) => a.atEpochMs - b.atEpochMs)
      .map(event => `${event.method}|${event.rpcIdFingerprint ?? "-"}`);
    routeSequence.set(String(socket.id), rows);
  }
  const appGroups = new Map();
  const routeGroups = new Map();
  for (const socket of applicationSockets) {
    const key = `${routeMetadataKey(socket)}|${JSON.stringify(appSequence.get(`${socket.pageId}:${socket.socketId}`) ?? [])}`;
    if (!appGroups.has(key)) appGroups.set(key, []);
    appGroups.get(key).push(socket);
  }
  for (const socket of routeSockets) {
    const key = `${routeMetadataKey(socket)}|${JSON.stringify(routeSequence.get(String(socket.id)) ?? [])}`;
    if (!routeGroups.has(key)) routeGroups.set(key, []);
    routeGroups.get(key).push(socket);
  }
  const groupKeys = new Set([...appGroups.keys(), ...routeGroups.keys()]);
  const usedApplication = new Set();
  const usedRoute = new Set();
  const pairs = [];
  const ambiguousGroups = [];
  const makePair = (applicationSocket, routeSocket, mode) => {
    const deltaMs = Math.abs(applicationSocket.atEpochMs - routeSocket.atEpochMs);
    if (deltaMs > 5_000) return false;
    const applicationKey = `${applicationSocket.pageId}:${applicationSocket.socketId}`;
    if (usedApplication.has(applicationKey) || usedRoute.has(routeSocket.id)) return false;
    usedApplication.add(applicationKey);
    usedRoute.add(routeSocket.id);
    pairs.push({
      applicationPageId: applicationSocket.pageId,
      applicationSocketId: applicationSocket.socketId,
      routeSocketId: routeSocket.id,
      path: routeSocket.path,
      serverFingerprint: routeSocket.serverFingerprint,
      channelFingerprint: routeSocket.channelFingerprint,
      workspaceFingerprint: routeSocket.workspaceFingerprint,
      requestSequenceFingerprint: sha256(JSON.stringify(appSequence.get(applicationKey) ?? [])).slice(0, 16),
      socketOpenedAtEpochMs: applicationSocket.atEpochMs,
      routeInstalledAtEpochMs: routeSocket.atEpochMs,
      absoluteOpenSkewMs: round(deltaMs),
      pairingMode: mode,
    });
    return true;
  };
  for (const key of groupKeys) {
    const appGroup = (appGroups.get(key) ?? []).slice().sort((a, b) => a.atEpochMs - b.atEpochMs);
    const routeGroup = (routeGroups.get(key) ?? []).slice().sort((a, b) => a.atEpochMs - b.atEpochMs);
    if (appGroup.length === routeGroup.length) {
      for (let index = 0; index < appGroup.length; index += 1) makePair(appGroup[index], routeGroup[index], appGroup.length === 1 ? "unique-metadata-and-full-request-sequence" : "identical-full-sequence-ordered-by-open-time");
      continue;
    }
    if (appGroup.length === 1 && routeGroup.length === 1) {
      if (makePair(appGroup[0], routeGroup[0], "unique-metadata-and-full-request-sequence")) continue;
    }
    if (appGroup.length || routeGroup.length) {
      const representative = appGroup[0] ?? routeGroup[0];
      const sequence = appGroup[0]
        ? appSequence.get(`${appGroup[0].pageId}:${appGroup[0].socketId}`) ?? []
        : routeSequence.get(String(routeGroup[0].id)) ?? [];
      ambiguousGroups.push({
        path: representative.path,
        serverFingerprint: representative.serverFingerprint,
        channelFingerprint: representative.channelFingerprint,
        workspaceFingerprint: representative.workspaceFingerprint,
        requestSequenceFingerprint: sha256(JSON.stringify(sequence)).slice(0, 16),
        applicationSocketCount: appGroup.length,
        routeSocketCount: routeGroup.length,
        reason: "Full method/ID request sequence and sanitized route metadata did not define a one-to-one timestamp-bounded socket pairing",
      });
    }
  }
  return {
    pairs: pairs.sort((a, b) => a.routeSocketId - b.routeSocketId),
    ambiguousGroups,
    unpairedApplicationSockets: applicationSockets.filter(row => !usedApplication.has(`${row.pageId}:${row.socketId}`)).map(row => ({
      pageId: row.pageId,
      socketId: row.socketId,
      path: row.path,
      serverFingerprint: row.serverFingerprint,
      channelFingerprint: row.channelFingerprint,
      workspaceFingerprint: row.workspaceFingerprint,
    })),
    unpairedRouteSockets: routeSockets.filter(row => !usedRoute.has(row.id)).map(row => ({
      routeSocketId: row.id,
      path: row.path,
      serverFingerprint: row.serverFingerprint,
      channelFingerprint: row.channelFingerprint,
      workspaceFingerprint: row.workspaceFingerprint,
    })),
  };
}

function summarizeActionTimelines(observations, network) {
  const actions = new Set([
    "task-shell-title-visible",
    "history-first-content-visible",
    "composer-ready",
    "return-home",
    "refresh-home",
    "drawer-open",
    "drawer-close",
    "input-feedback",
  ]);
  return observations.filter(row => row.actionId && actions.has(row.action)).map(row => {
    const pointerDownAt = row.pointerDownAtEpochMs;
    const routeTransactions = network.rpc.filter(rpc => rpc.actionId === row.actionId).map(rpc => ({
      method: rpc.method,
      rpcIdFingerprint: rpc.rpcIdFingerprint,
      configuredDelayMs: rpc.configuredDelayMs,
      requestSentAtEpochMs: rpc.requestSentAtEpochMs,
      responseReceivedAtEpochMs: rpc.responseReceivedAtEpochMs,
      responseForwardedAtEpochMs: rpc.responseForwardedAtEpochMs,
      requestAfterPointerDownMs: Number.isFinite(pointerDownAt) ? round(rpc.requestSentAtEpochMs - pointerDownAt) : null,
      responseAfterPointerDownMs: Number.isFinite(pointerDownAt) ? round(rpc.responseForwardedAtEpochMs - pointerDownAt) : null,
      visibleBeforeResponseForwarded: Number.isFinite(row.paintFeedbackAtEpochMs) ? row.paintFeedbackAtEpochMs < rpc.responseForwardedAtEpochMs : null,
      responsePathAppliedDelayMs: rpc.responsePathAppliedDelayMs,
      routeSocketId: rpc.routeSocketId,
    }));
    const browserRequests = network.browserFrames.filter(frame => frame.actionId === row.actionId && frame.direction === "sent" && frame.hasId && frame.method).map(frame => ({
      method: frame.method,
      rpcIdFingerprint: frame.rpcIdFingerprint,
      socketId: frame.socketId,
      atEpochMs: frame.atEpochMs,
      afterPointerDownMs: Number.isFinite(pointerDownAt) ? round(frame.atEpochMs - pointerDownAt) : null,
    }));
    return {
      action: row.action,
      actionId: row.actionId,
      cacheClass: row.cacheClass,
      configuredApplicationDelayMs: row.delayMs,
      ok: row.ok,
      clickStartedAtEpochMs: row.pointerDownAtEpochMs,
      domReadyAtEpochMs: row.domReadyAtEpochMs,
      visibleAtEpochMs: row.paintFeedbackAtEpochMs,
      domReadyMs: row.domReadyMs,
      visibleMs: row.paintFeedbackMs,
      targetSharesClickWith: observations.filter(other => other.actionId === row.actionId && other.action !== row.action).map(other => other.action),
      browserRpcRequests: browserRequests,
      routedRpcTransactions: routeTransactions,
    };
  });
}

function createCoverageLedger(delays, sampleCount, observations, network, gatewayCalls, snapshotMode) {
  const getSamples = (action, cacheClass, delayMs) => observations.filter(entry => entry.action === action && entry.cacheClass === cacheClass && entry.delayMs === delayMs && entry.ok).length;
  const requiredActionsByCache = {
    "hot-runtime": ["task-shell-title-visible", "history-first-content-visible", "composer-ready", "return-home", "drawer-open", "drawer-close", "input-feedback", "send-local-pending", "mock-gateway-turn-start-ack"],
    "cold-runtime-warm-profile": ["task-shell-title-visible", "history-first-content-visible", "composer-ready", "return-home", "refresh-home", "drawer-open", "drawer-close", "input-feedback", "send-local-pending", "mock-gateway-turn-start-ack"],
  };
  const core = delays.flatMap(delayMs => Object.entries(requiredActionsByCache).flatMap(([cacheClass, actions]) => actions.map(action => ({
    action,
    cacheClass,
    delayMs,
    samples: getSamples(action, cacheClass, delayMs),
    samplesPerRun: sampleCount,
    requiredByPlan: DEFAULT_SAMPLES,
    status: getSamples(action, cacheClass, delayMs) >= DEFAULT_SAMPLES ? "PASS" : getSamples(action, cacheClass, delayMs) > 0 ? "SMOKE" : "NOT_RUN",
  }))));
  const bothTransports = network.httpResponsePathDelays.length > 0 && network.websocketFrames > 0 && network.websocketResponsePathDelays.length > 0;
  const rpcFrameCorrelation = correlateRpcFrames(network);
  const applicationCaptureComplete = network.applicationWebSocketCaptureHealth.length > 0
    && network.applicationWebSocketCaptureHealth.every(row => row.socketOverflowCount === 0 && row.frameOverflowCount === 0 && row.storageWriteFailureCount === 0);
  const positiveDelays = delays.filter(delayMs => delayMs > 0);
  const websocketRouteCoverage = rpcFrameCorrelation.requestCoveragePercent === 100
    && rpcFrameCorrelation.responseCoveragePercent === 100
    && rpcFrameCorrelation.browserResponseCoveragePercent === 100
    && (positiveDelays.length === 0 || rpcFrameCorrelation.delayedResponseCoveragePercent === 100);
  const drawerClosedNoScans = network.drawerClosedListChecks.length > 0 && network.drawerClosedListChecks.every(row => row.requestsAfterTaskEntryBeforeDrawerOpen === 0);
  const drawerCloseNoScans = network.drawerCloseListChecks.length > 0 && network.drawerCloseListChecks.every(row => row.requestsAfterClose === 0);
  const baselineDrawerClosedStatus = drawerClosedNoScans ? "BASELINE_ZERO_OBSERVED" : "BASELINE_SCAN_OBSERVED";
  const drawerClosedStatus = snapshotMode === "before" ? baselineDrawerClosedStatus : drawerClosedNoScans ? "PASS" : "FAIL";
  const expectedMockTurnStarts = observations.filter(sample => sample.action === "send-local-pending").length;
  const observedBrowserTurnStarts = network.browserFrameMethodCounts["turn/start"] ?? 0;
  const configuredDelayEffect = positiveDelays.length > 0 && positiveDelays.every(delayMs =>
    network.httpResponsePathDelays.some(row => row.configuredDelayMs === delayMs && Number.isFinite(row.appliedDelayMs) && row.appliedDelayMs >= row.configuredDelayMs - APPLICATION_DELAY_TIMER_TOLERANCE_MS) &&
    network.websocketResponsePathDelays.some(row => row.configuredDelayMs === delayMs && Number.isFinite(row.appliedDelayMs) && row.appliedDelayMs >= row.configuredDelayMs - APPLICATION_DELAY_TIMER_TOLERANCE_MS));
  return {
    overallStatus: "PARTIAL",
    note: "P0 Mobile Web browser measurement only. PASS is scoped to the listed loopback/mock scenarios; unrun plan matrix rows remain explicit.",
    delayDefinition: "extra one-way delay applied after HTTP Gateway responses and before server-to-browser WebSocket frame delivery; not RTT or packet loss",
    coreSamples: core,
    rpcFrameCorrelation,
    matrix: [
      { id: "http-and-wss-response-path-observed", status: bothTransports ? "PATH_OBSERVED" : "PARTIAL", configuredDelaysMs: delays, httpResponseSamples: network.httpResponsePathDelays.length, websocketResponseFrames: network.websocketResponsePathDelays.length, timingBoundary: "delay is injected at HTTP response / server-to-browser frame path; configured zero validates routing only" },
      { id: "websocket-route-coverage", status: websocketRouteCoverage ? "PASS" : "PARTIAL", browserWebSocketCount: network.browserWebSocketConnections.length, routedWebSocketCount: network.routedWebSocketConnections.length, preShimNativeWebSocketCount: rpcFrameCorrelation.applicationWebSocketCount, socketPairCount: rpcFrameCorrelation.socketPairCount, ambiguousSocketGroups: rpcFrameCorrelation.ambiguousSocketGroups, browserObservedOutboundMethodCounts: network.browserFrameMethodCounts, preShimNativeRpcRequestFrames: rpcFrameCorrelation.browserRequestCount, routeRpcRequestFrames: rpcFrameCorrelation.routeRequestCount, matchedRequestFrames: rpcFrameCorrelation.matchedRequestCount, requestCoveragePercent: rpcFrameCorrelation.requestCoveragePercent, preShimNativeRpcResponses: rpcFrameCorrelation.browserResponseCount, routeRpcResponses: rpcFrameCorrelation.routeResponseCount, matchedRpcResponses: rpcFrameCorrelation.matchedRouteResponseCount, responseCoveragePercent: rpcFrameCorrelation.responseCoveragePercent, browserResponseCoveragePercent: rpcFrameCorrelation.browserResponseCoveragePercent, delayedRouteResponses: rpcFrameCorrelation.delayedRouteResponseCount, matchedDelayedResponses: rpcFrameCorrelation.matchedDelayedResponseCount, delayedResponseCoveragePercent: rpcFrameCorrelation.delayedResponseCoveragePercent, unmatchedBrowserRequestsByMethod: rpcFrameCorrelation.unmatchedBrowserRequestsByMethod, unmatchedRouteRequestsByMethod: rpcFrameCorrelation.unmatchedRouteRequestsByMethod, unmatchedDelayedResponses: rpcFrameCorrelation.unmatchedDelayedResponses, evidenceLayer: "native transport observations before Playwright WebSocketMock app dispatch", reason: websocketRouteCoverage ? null : "Native transport observations must correlate with routed request/response frames on a uniquely paired socket" },
      { id: "browser-route-rpc-frame-correlation", status: websocketRouteCoverage ? "PASS" : "PARTIAL", browserRequestsByMethod: rpcFrameCorrelation.browserRequestsByMethod, routeRequestsByMethod: rpcFrameCorrelation.routeRequestsByMethod, unmatchedBrowserRequests: rpcFrameCorrelation.unmatchedBrowserRequests, matchedRequestFrames: rpcFrameCorrelation.matchedRequestCount, unmatchedRouteRequests: rpcFrameCorrelation.unmatchedRouteRequests, unmatchedBrowserResponses: rpcFrameCorrelation.unmatchedBrowserResponses, unmatchedRouteResponses: rpcFrameCorrelation.unmatchedRouteResponses, matchedDelayedResponses: rpcFrameCorrelation.matchedDelayedResponses, ambiguousSocketGroups: rpcFrameCorrelation.ambiguousSocketGroups, preShimNativeObserverBeforeForwardCount: rpcFrameCorrelation.preShimNativeObserverBeforeForwardCount, preShimNativeObserverOffsetByConfiguredDelayMs: rpcFrameCorrelation.preShimNativeObserverOffsetByConfiguredDelayMs, timingBoundary: "Playwright-captured native transport observation correlated to routed RPC frames; it is upstream of WebSocketMock dispatch and is not app receipt" },
      { id: "pre-shim-native-websocket-evidence-capture", status: applicationCaptureComplete ? "DIAGNOSTIC_ONLY" : "FAIL", pageDrainCount: network.applicationWebSocketCaptureHealth.length, maxSocketsPerPage: Math.min(...network.applicationWebSocketCaptureHealth.map(row => row.maxSocketsPerPage)), maxFramesPerPage: Math.min(...network.applicationWebSocketCaptureHealth.map(row => row.maxFramesPerPage)), socketOverflowCount: network.applicationWebSocketCaptureHealth.reduce((sum, row) => sum + row.socketOverflowCount, 0), frameOverflowCount: network.applicationWebSocketCaptureHealth.reduce((sum, row) => sum + row.frameOverflowCount, 0), storageWriteFailureCount: network.applicationWebSocketCaptureHealth.reduce((sum, row) => sum + row.storageWriteFailureCount, 0), captureLayer: "native WebSocket captured before Playwright installs WebSocketMock", evidence: "bounded native transport observations are drained into Node after samples; this is not application-level receipt evidence" },
      { id: "application-websocket-dispatch-receipt", status: "UNVERIFIED", reason: "Playwright routeWebSocket captures the native constructor and replaces the page global with WebSocketMock; this initScript observes upstream native events, not dispatch into the app WebSocketMock/EventTarget. Delayed route forwarding and DOM visibility are measured separately." },
      { id: "positive-response-delay-effect", status: positiveDelays.length === 0 ? "NOT_RUN" : configuredDelayEffect ? "PASS" : "FAIL", configuredDelaysMs: positiveDelays, timingBoundary: "configured application-path hold, explicitly not network RTT" },
      { id: "fixture-sizes-50-500-2000-messages", status: "NOT_RUN", reason: "synthetic history volume sweep is a follow-up matrix; this first run measures navigation and local feedback" },
      { id: "slow-gateway-status-probe-12s", status: "NOT_RUN", reason: "separate 12s status-only injection not included in first core flow" },
      { id: "slow-optional-model-configuration", status: "NOT_RUN", reason: "model configuration RPC hold not included; no model RPC is sent in the core flow" },
      { id: "http-401-and-reauthorization", status: "NOT_RUN", reason: "auth expiry/401 behavior needs a dedicated isolated scenario" },
      { id: "disconnect-and-ack-loss", status: "NOT_RUN", reason: "WebSocket close and response drop require a dedicated recovery scenario" },
      { id: "jitter-and-real-packet-loss", status: "NOT_RUN", reason: "not simulated by fixed application response delays" },
      { id: "public-relay", status: "NOT_RUN_HERE", reason: "separate public validation run owns isolated test relay evidence" },
      { id: "drawer-closed-no-thread-list-scan", status: drawerClosedStatus, snapshotMode, samples: network.drawerClosedListChecks.length, nonzeroSamples: network.drawerClosedListChecks.filter(row => row.requestsAfterTaskEntryBeforeDrawerOpen > 0).length, evidence: "outbound thread/list RPC count after all startup RPCs quiesced, from task entry through interactive task shell until drawer open" },
      { id: "drawer-close-no-new-thread-list", status: snapshotMode === "before" ? (drawerCloseNoScans ? "BASELINE_ZERO_OBSERVED" : "BASELINE_SCAN_OBSERVED") : drawerCloseNoScans ? "PASS" : "FAIL", snapshotMode, samples: network.drawerCloseListChecks.length, nonzeroSamples: network.drawerCloseListChecks.filter(row => row.requestsAfterClose > 0).length, evidence: "outbound thread/list RPC count during 100ms after drawer close" },
      { id: "android-ios-hermes-native-performance", status: "UNVERIFIED", reason: "Chromium web viewport does not measure native JS/UI, keyboard, storage, or frame behavior" },
      { id: "no-real-provider-request", status: observedBrowserTurnStarts === expectedMockTurnStarts ? "PASS" : "FAIL", browserObservedMockTurnStarts: observedBrowserTurnStarts, routeObservedMockTurnStarts: gatewayCalls.turnStart, expectedPendingSamples: expectedMockTurnStarts, realProviderConfigured: false, gatewayMode: "KCODER_STUDIO_MOCK" },
    ],
  };
}

function percentile(values, q) {
  if (!values.length) return null;
  return values[Math.max(0, Math.ceil(values.length * q) - 1)];
}

function distribution(values) {
  const counts = Object.create(null);
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function parseFrame(raw) {
  try { return JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); } catch { return null; }
}

function threadListRpcCount(methodCounts) {
  return Object.entries(methodCounts)
    .filter(([method]) => /^(?:thread\/list|thread\.list)$/i.test(method))
    .reduce((sum, [, count]) => sum + count, 0);
}

function safePath(url) {
  try { return sanitizeGatewayPath(new URL(url).pathname); } catch { return "<invalid-url>"; }
}

function safeWebSocketRouteInfo(url) {
  try {
    const parsed = new URL(url);
    const fingerprint = names => {
      for (const name of names) {
        const value = parsed.searchParams.get(name);
        if (value) return sha256(`${name}:${value}`).slice(0, 12);
      }
      return null;
    };
    return {
      path: sanitizeGatewayPath(parsed.pathname),
      serverFingerprint: fingerprint(["serverId", "server"]),
      channelFingerprint: fingerprint(["channelId", "channel"]),
      workspaceFingerprint: fingerprint(["workspaceId", "workspace"]),
    };
  } catch {
    return { path: "<invalid-url>", serverFingerprint: null, channelFingerprint: null, workspaceFingerprint: null };
  }
}

function optionValue(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find(value => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rpcIdFingerprint(id) {
  return sha256(String(id)).slice(0, 16);
}

function epochNow() {
  return performance.timeOrigin + performance.now();
}

function round(value) {
  return Number(value.toFixed(3));
}

function delay(durationMs) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, durationMs));
}

async function waitUntilPerformanceDeadline(deadline) {
  let remainingMs;
  while ((remainingMs = deadline - performance.now()) > 0) await delay(Math.ceil(remainingMs));
}

function assertApplicationDelay(sample, minimumConfiguredDelayMs, label) {
  assert.ok(sample, `${label}: no completed delay evidence was captured`);
  assert.ok(
    Number.isFinite(sample.configuredDelayMs) && sample.configuredDelayMs >= minimumConfiguredDelayMs,
    `${label}: configured application delay ${sample.configuredDelayMs}ms did not reach ${minimumConfiguredDelayMs}ms`,
  );
  assert.ok(
    Number.isFinite(sample.appliedDelayMs) && sample.appliedDelayMs >= sample.configuredDelayMs - APPLICATION_DELAY_TIMER_TOLERANCE_MS,
    `${label}: applied application delay ${sample.appliedDelayMs}ms was more than ${APPLICATION_DELAY_TIMER_TOLERANCE_MS}ms below configured ${sample.configuredDelayMs}ms (application timer/clock rounding, not RTT)`,
  );
  return sample;
}
