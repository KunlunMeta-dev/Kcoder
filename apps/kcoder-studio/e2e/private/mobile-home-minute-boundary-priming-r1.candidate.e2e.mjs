import assert from "node:assert/strict";
import { findPersistedMobileDeviceById } from "./mobile-device-store-readback.private.mjs";
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
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { chromium as playwrightChromium } from "../../renderer/node_modules/@playwright/test/index.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { startOwnedDisplay } from "../harness/ai-verify-gateway.mjs";
import { appRoot, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { resolveExistingPrivateGatewaySnapshot, resolveExistingPrivatePath } from "../suites/mobile/helpers/gateway-runtime-snapshot-guard.mjs";
import { createAcceptedTurnReceiptFixture, createResponseJitter, mobileApiPath, sanitizeGatewayPath, sumResponseDelayMs } from "../suites/mobile/helpers/mobile-high-latency-fault-fixture.mjs";
import { findHttpResponseForRouteRequest } from "../suites/mobile/helpers/refresh-http-response-correlation.mjs";
import { drainAndArmBackgroundHttpResponseHold } from "../suites/mobile/helpers/refresh-background-window-visibility.mjs";
import { closeOwnedMobilePage, createRefreshProgressWriter, createTurnStartErrorFixtureFrame, observeOwnedMobilePage } from "../suites/mobile/helpers/refresh-send-background-fixture.mjs";
import { createPrivateMinuteBoundarySourceInputs } from "../harness/private-mobile-minute-boundary-source-inputs.mjs";
import { createPrivateMinuteBoundaryNetwork } from "../harness/private-mobile-minute-boundary-network.mjs";
import { createPrivateMinuteBoundaryFaultScenarios } from "../harness/private-mobile-minute-boundary-fault-scenarios.mjs";
import { observeSeparatedSuiteSourceInputs } from "../harness/separated-suite-source-inputs.mjs";


const SERVER_ID = "backend4a";
const THREAD_ID = "mock-active-session";
const HOME_FIXTURE_THREAD_TITLE = "移动任务操作测试";
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
const refreshHomeMinuteBoundaryDiagnosticMode = process.argv.includes("--home-minute-boundary-diagnostic");
const refreshSendDiagnostic = optionValue("--refresh-send-diagnostic", null);
const refreshSendDiagnosticMode = refreshSendDiagnostic === "accepted-600";
const refreshBackgroundDiagnostic = optionValue("--refresh-background-diagnostic", null);
const refreshBackgroundDiagnosticMode = refreshBackgroundDiagnostic === "home-600" || refreshHomeMinuteBoundaryDiagnosticMode;
const refreshSharedBackgroundDiagnosticMode = refreshBackgroundDiagnosticMode && !refreshHomeMinuteBoundaryDiagnosticMode;
const refreshBackgroundDiagnosticId = refreshHomeMinuteBoundaryDiagnosticMode
  ? "home-minute-boundary-600-x2-after-auth-35"
  : refreshBackgroundDiagnostic;
const refreshDiagnosticMode = refreshSendDiagnosticMode || refreshBackgroundDiagnosticMode;
const refreshBackgroundWindowMode = !refreshSendDiagnosticMode && (!refreshAuthCleanupUiGateMode || refreshHomeMinuteBoundaryDiagnosticMode);
const refreshSingleSampleMode = refreshSmokeMode || refreshDiagnosticMode || refreshAuthCleanupUiGateMode;
const formalOwnedAuthLifecycle = !refreshSingleSampleMode;
const refreshPerSampleAuthCleanupMode = formalOwnedAuthLifecycle || refreshHomeMinuteBoundaryDiagnosticMode;
const refreshCoverageMode = refreshDiagnosticMode
  ? "DIAGNOSTIC_ONLY"
  : refreshSmokeMode ? "SMOKE_ONLY" : refreshAuthCleanupUiGateMode ? "AUTH_CLEANUP_UI_GATE_ONLY" : "FORMAL_N30";
const REFRESH_AUTH_CLEANUP_UI_GATE_CYCLES = 35;
const REFRESH_HOME_MINUTE_BOUNDARY_TARGET_OFFSET_MS = 12_000;
const REFRESH_HOME_MINUTE_BOUNDARY_ELAPSED_MS = 119_500;
const REFRESH_HOME_MINUTE_BOUNDARY_FIRST_REQUEST_LEAD_MS = 800;
const REFRESH_HOME_MINUTE_BOUNDARY_REQUEST_LEAD_MARGIN_MS = 300;
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
assert.equal(refreshHomeMinuteBoundaryDiagnosticMode, refreshAuthCleanupUiGateMode && refreshBackgroundDiagnosticMode, "--home-minute-boundary-diagnostic requires the 35-cycle auth gate and selects the two Home diagnostics");
if (refreshAuthCleanupUiGateMode) {
  assert.equal(faultScenariosOnly, true, "auth cleanup UI gate requires --fault-scenarios");
  assert.equal(selectedFaultScenario, refreshScenarioId, "auth cleanup UI gate requires the refresh/send/background scenario");
  assert.equal(refreshSmokeMode, false, "auth cleanup UI gate cannot be combined with --refresh-smoke");
  assert.equal(refreshDiagnosticMode, refreshHomeMinuteBoundaryDiagnosticMode, "only the explicit Home minute-boundary mode may combine with the auth cleanup gate");
  assert.equal(navigationOnly, false, "auth cleanup UI gate cannot be combined with --navigation-only");
  assert.equal(drawerCloseDiagnosticsEnabled, false, "auth cleanup UI gate cannot be combined with drawer-close diagnostics");
  assert.equal(sampleCount, refreshHomeMinuteBoundaryDiagnosticMode ? 2 : 1, "the 35-cycle auth gate requires one sample; the combined Home minute-boundary diagnostic requires exactly two");
  assert.deepEqual(delayValues, refreshHomeMinuteBoundaryDiagnosticMode ? [600] : [0], "only the combined Home diagnostic uses a 600ms isolated HTTP response hold");
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

const { resolvePrivateBeforeComplementRoot, prepareSnapshot, reuseMobileWebExport, hashMobileExportSourceRoots, appendExportSourceFiles, exportSourceExcluded, hashBundleTree, prepareGatewayRuntimeSnapshot, inspectGatewayRuntimeSnapshot, hashGatewayRuntimeInputs, appendGatewaySnapshotFiles, sourceSnapshotFilter, dependencySnapshotFilter, dependencySnapshotExcluded, sourceSnapshotExcluded, assertNoEscapingLinks, readGatewayExecutableInputs, regularFileIdentity, gatewayRuntimeStable, startFrozenGateway, copySanitizedTree, createDependencySnapshot, removeDependencyCacheAndSecretFiles, dependencyExcludedCategory, copyArtifactTree, excludedCategory, hashComplement, appendFileHashes, listFiles, pruneEmptyDirectories } = createPrivateMinuteBoundarySourceInputs({
  access,
  appRoot,
  assert,
  basename,
  copyFile,
  cp,
  lstat,
  mkdir,
  randomBytes,
  readFile,
  readdir,
  readlink,
  realpath,
  relative,
  repoRoot,
  resolve,
  resolveExistingPrivateGatewaySnapshot,
  resolveExistingPrivatePath,
  reuseExportDirectory,
  reuseExportManifest,
  rm,
  rmdir,
  sep,
  sha256,
  snapshotMode,
  stat,
  waitFor,
  writeFile,
});

const { sanitizeRpcEventForCheckpoint, pendingRouteRequestsAt, recordRoutedWebSocketCloseInvocation, beginNavigationSampleCapture, writeNavigationSampleCheckpoint, installPageInstrumentation, installNetworkInstrumentation, waitForGatewayRpcQuiescence, pendingGatewayActivity, gatewayActivityFingerprint, snapshotNetworkEvidence, deepFreeze, createNetworkLedger, summarizeObservations, scenarioStatus, summarizeNetwork, correlateRpcFrames, pairApplicationAndRouteSockets, summarizeActionTimelines, createCoverageLedger } = createPrivateMinuteBoundaryNetwork({
  APPLICATION_DELAY_TIMER_TOLERANCE_MS,
  DEFAULT_SAMPLES,
  REFRESH_HOME_MINUTE_BOUNDARY_ELAPSED_MS,
  REFRESH_HOME_MINUTE_BOUNDARY_TARGET_OFFSET_MS,
  SERVER_ID,
  THREAD_ID,
  createTurnStartErrorFixtureFrame,
  delay,
  distribution,
  drawerCloseDiagnosticsEnabled,
  epochNow,
  mobileApiPath,
  parseFrame,
  percentile,
  performance,
  refreshCoverageMode,
  refreshHomeMinuteBoundaryDiagnosticMode,
  refreshSingleSampleMode,
  round,
  rpcIdFingerprint,
  safePath,
  safeWebSocketRouteInfo,
  sampleCount,
  sanitizeGatewayPath,
  sha256,
  sumResponseDelayMs,
  waitUntilPerformanceDeadline,
});

const { runPhoneUxFaultScenarios } = createPrivateMinuteBoundaryFaultScenarios({
  APPLICATION_DELAY_TIMER_TOLERANCE_MS,
  DEFAULT_DELAYS,
  DEFAULT_SAMPLES,
  REFRESH_BACKGROUND_MOBILE_SESSIONS,
  REFRESH_HOME_MINUTE_BOUNDARY_FIRST_REQUEST_LEAD_MS,
  REFRESH_HOME_MINUTE_BOUNDARY_REQUEST_LEAD_MARGIN_MS,
  SERVER_ID,
  THREAD_ID,
  applyRefreshBackgroundMobileEmulation,
  assert,
  assertApplicationDelay,
  assertHomeThreadPresentationStableExceptRelativeTime,
  assertRunningControlsStayHiddenAfterTwoFrames,
  captureHomeThreadPresentation,
  capturePrivateFailureScreenshot,
  closeOwnedMobilePage,
  closeRefreshDiagnosticMobilePage,
  connectMobile,
  createAcceptedTurnReceiptFixture,
  createRefreshProgressWriter,
  createResponseJitter,
  delayValues,
  describeVisiblePage,
  distribution,
  drainAndArmBackgroundHttpResponseHold,
  ensureFixtureSessionVisible,
  epochNow,
  faultScenarioIds,
  findHttpResponseForRouteRequest,
  formalOwnedAuthLifecycle,
  newMobilePage,
  normalizeHomeThreadRowText,
  observeLoginResponses,
  observeOwnedMobileAuth,
  openFixtureSession,
  ownedMobileDeviceStorePath,
  percentile,
  performance,
  readOwnedMobileDeviceSummary,
  readRefreshBackgroundMobileFacts,
  refreshBackgroundDiagnosticId,
  refreshBackgroundDiagnosticMode,
  refreshBackgroundMobileFactsMatch,
  refreshBackgroundWindowMode,
  refreshCoverageMode,
  refreshDiagnosticMode,
  refreshHomeMinuteBoundaryDiagnosticMode,
  refreshPerSampleAuthCleanupMode,
  refreshScenarioId,
  refreshSendDiagnostic,
  refreshSendDiagnosticMode,
  refreshSharedBackgroundDiagnosticMode,
  refreshSingleSampleMode,
  refreshSmokeMode,
  releaseOwnedMobileAuthSample,
  round,
  safePath,
  sampleCount,
  sanitizeGatewayPath,
  selectedFaultScenario,
  sha256,
  startRefreshBackgroundChromium,
  summarizeHttpDelaySample,
  summarizeNetwork,
  summarizeWebSocketDelaySample,
  waitFor,
  waitForGatewayRpcQuiescence,
});

await runE2E(import.meta.url, {
  testId: "mobile-ux-refresh-send-background-candidate",
  tier: "manual-live",
  modelPolicy: "real Mobile Web UI through isolated KCODER_STUDIO_MOCK; background samples use a fresh owned Chromium default context with trusted real-window visibility, send samples use fresh BrowserContexts; explicit accepted-600 diagnostic, zero-delay all-action smoke, 35-cycle fresh-context auth-cleanup gate, and formal n30 modes are separately gated; no real Provider or native claim",
  retainSuccessLogs: true,
}, async context => {
  await observeSeparatedSuiteSourceInputs(context, [
    import.meta.url,
    new URL("../harness/private-mobile-minute-boundary-source-inputs.mjs", import.meta.url),
    new URL("../harness/private-mobile-minute-boundary-network.mjs", import.meta.url),
    new URL("../harness/private-mobile-minute-boundary-fault-scenarios.mjs", import.meta.url),
  ]);
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
  const chromium = refreshSharedBackgroundDiagnosticMode
    ? await startRefreshBackgroundChromium(context, { host: refreshBackgroundHost, instanceKey: "home-600-diagnostic" })
    : await startChromium(context, {
      label: "phone-ux-mobile-chromium",
      noSandbox: true,
    });
  const refreshDiagnosticBrowserContext = refreshSharedBackgroundDiagnosticMode
    ? await requireOwnedDefaultBrowserContext(chromium.browser)
    : null;
  if (refreshSharedBackgroundDiagnosticMode) assert.equal(refreshDiagnosticBrowserContext, chromium.defaultContext, "first noDefaults context identity changed before the Mobile fixture");

  const observations = [];
  const network = createNetworkLedger();
  const browserErrors = [];
  const gatewayCalls = { turnStart: 0, modelCatalogRpcRequests: 0 };

  if (faultScenariosOnly) {
    let combinedAuthCleanupGate = null;
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
      combinedAuthCleanupGate = authCleanupGate;
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
      if (!refreshHomeMinuteBoundaryDiagnosticMode) return;
    }

    const faultScenarios = await runPhoneUxFaultScenarios(chromium, gateway, network, gatewayCalls, browserErrors, context, refreshBackgroundHost, workspace);
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
        : refreshHomeMinuteBoundaryDiagnosticMode
          ? "35 fresh-context auth cleanup cycles followed by two serial Home diagnostics; each uses a test-controlled thread/list updatedAt, an actual owned-window minimize/restore, trusted visibility, and a 600ms /api/servers response hold; diagnostic only, no percentile or formal n=30 claim"
          : refreshBackgroundDiagnosticMode
            ? "single home background/foreground diagnostic with a 600ms mock /api/servers response hold; no percentile or formal n=30 claim"
        : "functional scenario evidence only; no P50/P95 claim unless a scenario explicitly records 30 complete samples",
      refreshCoverageMode: refreshSendDiagnosticMode
        ? "DIAGNOSTIC_ONLY; one accepted-send sample at a 600ms mock ACK hold; excluded from formal n=30 coverage"
        : refreshHomeMinuteBoundaryDiagnosticMode
          ? "DIAGNOSTIC_ONLY; 35-cycle auth cleanup plus two Home samples with controlled relative-time minute boundaries and 600ms mock /api/servers holds; excluded from formal n=30 coverage"
          : refreshBackgroundDiagnosticMode
            ? "DIAGNOSTIC_ONLY; one home resume refresh sample at a 600ms mock /api/servers hold using actual owned-window minimize/restore and trusted visibility; excluded from formal n=30 coverage"
        : refreshSmokeMode ? "SMOKE_ONLY; one sample per action at zero delay; not formal n=30 coverage" : "FORMAL_N30",
      authCleanupUiGate: combinedAuthCleanupGate ? {
        status: combinedAuthCleanupGate.status,
        requiredCycles: combinedAuthCleanupGate.requiredCycles,
        attemptedCycles: combinedAuthCleanupGate.attemptedCycles,
        passedCycles: combinedAuthCleanupGate.passedCycles,
        distinctBrowserContexts: combinedAuthCleanupGate.distinctBrowserContexts,
        distinctDeviceFingerprints: combinedAuthCleanupGate.distinctDeviceFingerprints,
        activeDeviceCountAfterAll: combinedAuthCleanupGate.activeDeviceCountAfterAll,
      } : null,
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

function safeMutationErrorField(value) {
  if (typeof value === "string" && /^[A-Za-z0-9_:-]{1,64}$/.test(value)) return value;
  if (Number.isSafeInteger(value)) return value;
  return null;
}

async function readOwnedMobileDeviceSummary(path, targetDeviceId = null) {
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
  const activeDevice = device => Boolean(device && device.revoked !== true
    && Number.isSafeInteger(device.expiresAt) && device.expiresAt > now
    && Number.isSafeInteger(device.absoluteExpiresAt) && device.absoluteExpiresAt > now);
  const matchingDevice = findPersistedMobileDeviceById(store.devices, targetDeviceId);
  return {
    active: store.devices.filter(activeDevice).length,
    revoked: store.devices.filter(device => device?.revoked === true).length,
    stored: store.devices.length,
    ...(typeof targetDeviceId === "string" ? {
      exactDevice: {
        deviceFingerprint: sha256(targetDeviceId).slice(0, 16),
        present: Boolean(matchingDevice),
        revoked: matchingDevice?.revoked === true,
        active: activeDevice(matchingDevice),
      },
    } : {}),
  };
}

async function releaseOwnedMobileAuthSample(page, gateway, capture, runContext) {
  let pair = capture.getPair();
  if (!pair) pair = await capture.waitForObservation(750).catch(() => null);
  const failures = [];
  let revokeStatus = "not-attempted";
  let revokeFailure = null;
  let revokeElapsedMs = null;
  const revokeTimeoutMs = 2_000;
  if (pair?.accessToken) {
    const revokeSignal = AbortSignal.timeout(revokeTimeoutMs);
    const revokeStartedAt = performance.now();
    try {
      const response = await fetch(`${gateway.baseUrl}/api/mobile/session`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${pair.accessToken}`, accept: "application/json" },
        redirect: "manual",
        signal: revokeSignal,
      });
      revokeStatus = response.status;
      revokeElapsedMs = round(performance.now() - revokeStartedAt);
    } catch (error) {
      revokeStatus = "request-failed";
      revokeElapsedMs = round(performance.now() - revokeStartedAt);
      revokeFailure = {
        name: safeMutationErrorField(error?.name),
        code: safeMutationErrorField(error?.code),
        causeCode: safeMutationErrorField(error?.cause?.code),
        elapsedMs: revokeElapsedMs,
        timeoutMs: revokeTimeoutMs,
        timeoutObserved: revokeSignal.aborted,
      };
    }
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
  try { deviceStore = await readOwnedMobileDeviceSummary(ownedMobileDeviceStorePath(gateway), pair?.deviceId ?? null); }
  catch { failures.push("owned-device-store-unreadable"); }
  if (deviceStore && deviceStore.active !== 0) failures.push("active-owned-device-remained");
  if (deviceStore?.exactDevice?.active === true) failures.push("exact-owned-device-remained-active");
  if (revokeStatus === 204 && deviceStore?.exactDevice?.revoked !== true) failures.push("exact-device-revoke-not-visible-in-store");
  capture.dispose();
  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    pairResponseStatus: pair?.status ?? "not-observed",
    deviceFingerprint: pair?.deviceId ? sha256(pair.deviceId).slice(0, 16) : null,
    durableGrantObserved: pair?.mobileRefreshV1 === true,
    revokeStatus,
    revokeElapsedMs,
    revokeTimeoutMs: pair?.accessToken ? revokeTimeoutMs : null,
    revokeFailure,
    exactDeviceReadback: deviceStore?.exactDevice ?? null,
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
    page.__phoneUxPageId = pageId;
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

async function captureHomeThreadPresentation(page, network, stage, expectedWorkspace) {
  const row = page.getByTestId(`thread-${THREAD_ID}`);
  const workspaceHeader = page.getByTestId(`toggle-server-${SERVER_ID}`);
  await row.waitFor({ state: "visible", timeout: 5_000 });
  await workspaceHeader.waitFor({ state: "visible", timeout: 5_000 });
  const fixture = [...network.homeThreadSnapshots].reverse().find(item => item.threadId === THREAD_ID
    && (!refreshHomeMinuteBoundaryDiagnosticMode || item.stage === stage));
  assert.ok(fixture, "the mock Gateway thread/list response for the fixture Home row must be captured");
  if (refreshHomeMinuteBoundaryDiagnosticMode) {
    assert.ok(fixture.controlledMinuteBoundary, "the exact Home sample stage must use its controlled relative-time fixture");
  }
  assert.equal(fixture.serverId, SERVER_ID, "fixture thread/list response must belong to the expected server");
  assert.equal(fixture.title, HOME_FIXTURE_THREAD_TITLE, "fixture thread title must remain exact");
  assert.equal(fixture.status, "idle", "fixture thread status must remain idle");
  assert.equal(fixture.cwd, expectedWorkspace, "fixture thread cwd must stay in the owned workspace");
  assert.equal(typeof fixture.updatedAt, "number", "fixture thread timestamp must remain numeric");
  const presentation = await row.evaluate(element => {
    const textNodes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue?.trim();
      if (value) textNodes.push(value);
    }
    return { rowText: element.innerText ?? "", textNodes };
  });
  const workspaceHeaderText = await workspaceHeader.innerText();
  assert.equal(presentation.textNodes[0], fixture.title, "visible Home row title must match the exact thread/list record");
  assert.equal(presentation.textNodes.length, 2, "idle Home row must show title and relative-time only, with no status label");
  assertValidHomeRelativeTimeLabel(presentation.textNodes[1], `${stage} capture`);
  assert.ok(workspaceHeaderText.includes(expectedWorkspace), "visible row must remain under its exact workspace header");
  return {
    stage,
    pageId: page.__phoneUxPageId ?? null,
    serverId: SERVER_ID,
    threadId: fixture.threadId,
    workspacePath: expectedWorkspace,
    fixture: {
      sourceStage: fixture.stage,
      routeSocketId: fixture.routeSocketId,
      title: fixture.title,
      status: fixture.status,
      cwd: fixture.cwd,
      updatedAt: fixture.updatedAt,
      minuteBoundary: fixture.controlledMinuteBoundary ?? null,
    },
    visible: true,
    rowText: presentation.rowText,
    textNodes: presentation.textNodes,
    titleText: presentation.textNodes[0],
    relativeTimeText: presentation.textNodes[1],
    statusTextNodes: presentation.textNodes.slice(2),
    workspaceHeaderText,
    capturedAtEpochMs: await page.evaluate(() => Date.now()),
  };
}

function assertValidHomeRelativeTimeLabel(value, phase) {
  assert.equal(typeof value, "string", `Home relative-time label must be text ${phase}`);
  assert.ok(
    value === "未知时间"
      || value === "刚刚"
      || /^[1-9]\d* 分钟$/u.test(value)
      || /^[1-9]\d* 小时$/u.test(value)
      || /^[1-9]\d* 天$/u.test(value),
    `Home relative-time label must match the product's finite timestamp formats ${phase}`,
  );
}

function normalizeHomeThreadRowText(presentation) {
  const value = presentation.relativeTimeText;
  assert.equal(typeof value, "string");
  assert.ok(value.length > 0, "Home relative-time text must be captured separately");
  const first = presentation.rowText.indexOf(value);
  assert.ok(first >= 0, "captured relative-time text must occur in the raw Home row text");
  assert.equal(presentation.rowText.indexOf(value, first + value.length), -1, "relative-time text must occur exactly once in the raw Home row text");
  return `${presentation.rowText.slice(0, first)}<relative-time>${presentation.rowText.slice(first + value.length)}`;
}

function assertHomeThreadPresentationStableExceptRelativeTime(before, after, phase) {
  assert.equal(after.visible, true, `Home row must remain visible ${phase}`);
  assertValidHomeRelativeTimeLabel(before.relativeTimeText, `before ${phase}`);
  assertValidHomeRelativeTimeLabel(after.relativeTimeText, `after ${phase}`);
  for (const key of ["pageId", "serverId", "threadId", "workspacePath"]) {
    assert.equal(after[key], before[key], `Home row ${key} must remain unchanged ${phase}`);
  }
  for (const key of ["title", "status", "cwd", "updatedAt"]) {
    assert.equal(after.fixture[key], before.fixture[key], `mock thread/list ${key} must remain unchanged ${phase}`);
  }
  assert.equal(after.titleText, before.titleText, `visible Home title must remain unchanged ${phase}`);
  assert.deepEqual(after.statusTextNodes, before.statusTextNodes, `visible Home status text must remain unchanged ${phase}`);
  assert.equal(after.workspaceHeaderText, before.workspaceHeaderText, `visible Home workspace context must remain unchanged ${phase}`);
  const beforeWithoutTime = normalizeHomeThreadRowText(before);
  const afterWithoutTime = normalizeHomeThreadRowText(after);
  assert.equal(afterWithoutTime, beforeWithoutTime, `raw Home row text may change only at its computed relative-time field ${phase}`);
  return {
    onlyRelativeTimeFieldMayChange: true,
    relativeTimeChanged: before.relativeTimeText !== after.relativeTimeText,
    rawRowTextBefore: before.rowText,
    rawRowTextAfter: after.rowText,
    normalizedRowTextBefore: beforeWithoutTime,
    normalizedRowTextAfter: afterWithoutTime,
    fixtureFieldsUnchanged: true,
    workspaceHeaderUnchanged: true,
  };
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
