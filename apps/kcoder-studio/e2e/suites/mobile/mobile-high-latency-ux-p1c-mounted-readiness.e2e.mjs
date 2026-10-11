import { createMobileLatencyHelpers } from "../../harness/mobile-latency-helpers.mjs";
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
import { performance } from "node:perf_hooks";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { appRoot, repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { resolveExistingPrivateGatewaySnapshot, resolveExistingPrivatePath } from "../../harness/gateway-runtime-snapshot-guard.mjs";
import { createAcceptedTurnReceiptFixture, createResponseJitter, mobileApiPath, sanitizeGatewayPath, sumResponseDelayMs } from "../../harness/mobile-high-latency-fault-fixture.mjs";
import {
  createP1CActiveRunSummary,
  createP1CBufferedNotificationFrames,
  createP1CStartedTurnFrame,
  createP1CTurnStartErrorFixtureFrame,
} from "./helpers/p1c-mounted-readiness-fixture.mjs";

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
const p1cOnly = process.argv.includes("--p1c-only");
const p1cScenarioIds = [
  "p1c-history-first-agent-and-model-catalog-pending",
  "p1c-history-draft-and-failed-retry-during-config-pending",
  "p1c-buffered-notifications-during-thread-read",
  "p1c-reconnect-known-vs-unknown-active-turn",
];
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
  ...p1cScenarioIds,
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
assert.equal(p1cOnly, true, "the mounted P1-C entry requires --p1c-only before resource startup");
if (p1cOnly) {
  assert.equal(faultScenariosOnly, true, "--p1c-only requires --fault-scenarios");
  assert.ok(p1cScenarioIds.includes(selectedFaultScenario), "--p1c-only requires one --fault-scenario from the mounted P1-C candidate");
  assert.equal(sampleCount, 1, "P1-C mounted readiness cases are functional n=1 checks, not performance samples");
  assert.deepEqual(delayValues, [0], "P1-C mounted readiness cases require --delay=0");
} else {
  assert.ok(!p1cScenarioIds.includes(selectedFaultScenario), "P1-C scenarios require the explicit --p1c-only gate");
}

const {
  resolvePrivateBeforeComplementRoot,
  prepareSnapshot,
  reuseMobileWebExport,
  hashMobileExportSourceRoots,
  appendExportSourceFiles,
  exportSourceExcluded,
  hashBundleTree,
  prepareGatewayRuntimeSnapshot,
  inspectGatewayRuntimeSnapshot,
  hashGatewayRuntimeInputs,
  appendGatewaySnapshotFiles,
  sourceSnapshotFilter,
  dependencySnapshotFilter,
  dependencySnapshotExcluded,
  sourceSnapshotExcluded,
  assertNoEscapingLinks,
  readGatewayExecutableInputs,
  regularFileIdentity,
  gatewayRuntimeStable,
  startFrozenGateway,
  copySanitizedTree,
  createDependencySnapshot,
  removeDependencyCacheAndSecretFiles,
  dependencyExcludedCategory,
  copyArtifactTree,
  excludedCategory,
  hashComplement,
  appendFileHashes,
  listFiles,
  pruneEmptyDirectories,
  connectMobile,
  collectPreShimNativeWebSocketEvidence,
  ensureFixtureSessionVisible,
  describeVisiblePage,
  observeLoginResponses,
  capturePrivateFailureScreenshot,
  summarizeHttpDelaySample,
  summarizeWebSocketDelaySample,
  openFixtureSession,
  assertRunningControlsStayHiddenAfterTwoFrames,
  measureClick,
  measureDrawerAndInput,
  beginDrawerCloseDomTrace,
  finishDrawerCloseDomTrace,
  describeDrawerCloseState,
  sanitizeRpcEventForCheckpoint,
  pendingRouteRequestsAt,
  recordRoutedWebSocketCloseInvocation,
  beginNavigationSampleCapture,
  writeNavigationSampleCheckpoint,
  installPageInstrumentation,
  waitForGatewayRpcQuiescence,
  pendingGatewayActivity,
  gatewayActivityFingerprint,
  snapshotNetworkEvidence,
  deepFreeze,
  createNetworkLedger,
  summarizeObservations,
  scenarioStatus,
  correlateRpcFrames,
  pairApplicationAndRouteSockets,
  summarizeActionTimelines,
  createCoverageLedger,
  threadListRpcCount,
} = createMobileLatencyHelpers({
  sha256,
  snapshotMode,
  reuseExportDirectory,
  reuseExportManifest,
  round,
  epochNow,
  THREAD_ID,
  SERVER_ID,
  safePath,
  delay,
  drawerCloseDiagnosticsEnabled,
  sampleCount,
  DEFAULT_SAMPLES,
  percentile,
  APPLICATION_DELAY_TIMER_TOLERANCE_MS,
  suiteUrl: import.meta.url,
});

await runE2E(import.meta.url, {
  testId: "mobile-ux-p1c-mounted-readiness-candidate",
  tier: "manual-live",
  modelPolicy: "functional mounted Mobile Web readiness and test-generated protocol-fixture checks in isolated KCODER_STUDIO_MOCK; no model Provider, Rust Engine event claim, or latency distribution",
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
  const chromium = await startChromium(context, {
    label: "phone-ux-mobile-chromium",
    noSandbox: true,
  });

  const observations = [];
  const network = createNetworkLedger();
  const browserErrors = [];
  const gatewayCalls = { turnStart: 0, modelCatalogRpcRequests: 0 };

  if (faultScenariosOnly) {
    const faultScenarios = await runPhoneUxFaultScenarios(chromium, gateway, network, gatewayCalls, browserErrors, context);
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
      scenarioSubsetStatus: faultScenarios.requiredScenarioFailures.length === 0 ? "PASS" : "FAIL",
      selectedScenario: selectedFaultScenario ?? "all-required-fault-scenarios",
      scenarioScope: selectedFaultScenario ? "single named fault scenario only; not full matrix completion" : "all required fault scenarios",
      fullPlanStatus: "PARTIAL",
      mode: "isolated Mobile Web / KCODER_STUDIO_MOCK Gateway; browser-level HTTP/WSS response fixtures; no model provider",
      sampleClassification: "functional scenario evidence only; no P50/P95 claim unless a scenario explicitly records 30 complete samples",
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
        { id: "runtime-model-catalog-slow-12s", status: scenarioStatus(faultScenarios.rows, "runtime-model-catalog-slow-12s"), evidenceBoundary: "typed mock thread model fixture plus real UI-persisted workspace model/effort preference; no model Provider request" },
        ...p1cScenarioIds.map(id => ({
          id,
          status: scenarioStatus(faultScenarios.rows, id),
          evidenceBoundary: "mounted Mobile Web UI through isolated KCODER_STUDIO_MOCK; test-generated protocol frames are Playwright WebSocket route fixtures, not Rust Engine-originated events",
        })),
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
        viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
        evidenceBoundary: "Chromium mobile viewport emulation; not native Android/iOS profiling",
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
      await page.context().close();
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
    await hotPage.context().close();
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

async function runPhoneUxFaultScenarios(chromium, gateway, network, gatewayCalls, browserErrors, context) {
  const rows = [];
  const requiredScenarioFailures = [];
  let receiptSummary = null;
  const persistProgress = () => {
    const completedScenarioCount = rows.filter(row => row.status === "PASS" || row.status === "FAIL").length;
    const expectedScenarioCount = selectedFaultScenario ? 1 : faultScenarioIds.length - p1cScenarioIds.length;
    const progressArtifactName = `phone-ux-fault-progress-${String(completedScenarioCount).padStart(2, "0")}.json`;
    return context.writeArtifactJson(progressArtifactName, {
      schemaVersion: 1,
      status: rows.some(row => row.status === "FAIL")
        ? "PARTIAL_FAIL"
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
    if (p1cScenarioIds.includes(scenarioId) && !p1cOnly) return null;
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
      row.status = "PASS";
    } catch (error) {
      row.status = "FAIL";
      row.error = context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 700);
      if (page && !page.isClosed()) row.pageAtFailure = await describeVisiblePage(page);
      requiredScenarioFailures.push({ scenario: scenarioId, reason: row.error });
    } finally {
      row.durationMs = round(performance.now() - startedAt);
      if (page && !page.isClosed()) await page.close().catch(() => {});
      if (row.status !== "PASS") {
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

  await runCase(p1cScenarioIds[0], {
    threadModelFixture: true,
    testCapabilities: { agentSteering: true },
    methodDelayMs: {},
  }, async (page, row, scenarioControl) => {
    const setupStage = `fault:${row.scenario}:preference-setup`;
    network.currentStage = setupStage;
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("conversation-model-selector").click();
    await page.getByTestId("conversation-model-mock-minimax").waitFor({ state: "visible", timeout: 10_000 });
    const preferenceRequest = await waitFor(
      () => network.rpcEvents.find(item => item.direction === "request" && item.method === "runtime.models.list" && item.stage === setupStage),
      10_000,
      "real model-picker runtime.models.list request for persisted preference setup",
    );
    await page.getByTestId("conversation-model-mock-minimax").click();
    const highEffort = page.getByRole("radio", { name: "高", exact: true });
    await highEffort.waitFor({ state: "visible", timeout: 10_000 });
    await waitFor(() => highEffort.isEnabled(), 10_000, "model preference write to settle");
    await highEffort.click();
    await waitFor(async () => (await page.getByTestId("conversation-model-selector").innerText()).includes("高"), 10_000, "persisted high reasoning effort visible in task UI");
    const dialogs = page.getByRole("dialog").filter({ hasText: "模型与推理强度" });
    await dialogs.last().getByLabel("关闭", { exact: true }).click();
    await waitFor(async () => (await dialogs.count()) === 0, 10_000, "model preference dialog closed");
    await page.getByRole("button", { name: "返回" }).click();
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 10_000 });
    await ensureFixtureSessionVisible(page);
    await waitForGatewayRpcQuiescence(network, 15_000, 100);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    await ensureFixtureSessionVisible(page);

    scenarioControl.methodDelayMs["agent/list"] = 12_000;
    scenarioControl.methodDelayMs["runtime.models.list"] = 12_000;
    const reentryStage = `fault:${row.scenario}:reentry-both-optional-requests-held`;
    network.currentStage = reentryStage;
    const clickStartedAt = performance.now();
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    const requests = await waitFor(() => {
      const agent = network.rpcEvents.find(item => item.direction === "request" && item.method === "agent/list" && item.stage === reentryStage);
      const models = network.rpcEvents.find(item => item.direction === "request" && item.method === "runtime.models.list" && item.stage === reentryStage);
      return agent && models ? { agent, models } : null;
    }, 10_000, "both optional agent/list and runtime.models.list requests during task re-entry");
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 10_000 });
    const pendingDraft = "P1C_EDITABLE_WHILE_CONFIGURATION_PENDING";
    await page.getByTestId("message-input").fill(pendingDraft);
    const historyVisibleAt = performance.now();
    const responseAlreadyForwarded = method => network.rpcEvents.some(item => item.direction === "response-forwarded" && item.method === method && item.stage === reentryStage);
    assert.equal(responseAlreadyForwarded("agent/list"), false, "history must be visible while optional agent/list is held");
    assert.equal(responseAlreadyForwarded("runtime.models.list"), false, "history must be visible while optional model configuration is held");
    assert.ok(historyVisibleAt - clickStartedAt < 10_000, "mounted history must appear before the 12-second optional response holds");
    assert.equal(await page.getByTestId("message-input").isEnabled(), true, "composer remains editable while the optional requests are pending");
    assert.equal(await page.getByTestId("message-input").inputValue(), pendingDraft, "the actual mounted composer must retain the draft typed during configuration restore");
    assert.equal(await page.getByTestId("send-message").isDisabled(), true, "send remains gated while the required model configuration is pending");
    assert.ok((await page.getByTestId("conversation-model-selector").innerText()).includes("高"), "the UI-persisted reasoning preference remains visible during restore");
    const [agentResponse, modelResponse] = await Promise.all([
      waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "agent/list" && item.rpcIdFingerprint === requests.agent.rpcIdFingerprint && item.stage === reentryStage), 20_000, "held agent/list response"),
      waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "runtime.models.list" && item.rpcIdFingerprint === requests.models.rpcIdFingerprint && item.stage === reentryStage), 20_000, "held runtime.models.list response"),
    ]);
    const agentDelay = network.websocketResponsePathDelays.find(item => item.method === "agent/list" && item.rpcIdFingerprint === requests.agent.rpcIdFingerprint && item.stage === reentryStage);
    const modelDelay = network.websocketResponsePathDelays.find(item => item.method === "runtime.models.list" && item.rpcIdFingerprint === requests.models.rpcIdFingerprint && item.stage === reentryStage);
    assertApplicationDelay(agentDelay, 12_000, "optional agent/list response hold");
    assertApplicationDelay(modelDelay, 12_000, "optional runtime.models.list response hold");
    row.checks = {
      ...row.checks,
      preferenceChosenThroughMobileUi: true,
      preferenceSetupRequestIdFingerprint: preferenceRequest.rpcIdFingerprint,
      agentListRequestIdFingerprint: requests.agent.rpcIdFingerprint,
      modelListRequestIdFingerprint: requests.models.rpcIdFingerprint,
      historyVisibleBeforeBothOptionalResponses: historyVisibleAt - clickStartedAt < 10_000,
      composerEditableWhileBothResponsesPending: true,
      sendDisabledWhileConfigurationPending: true,
      agentListResponseCompleted: Boolean(agentResponse),
      modelListResponseCompleted: Boolean(modelResponse),
      agentListAppliedDelayMs: agentDelay.appliedDelayMs,
      modelListAppliedDelayMs: modelDelay.appliedDelayMs,
      modelPreferenceRemainsVisible: true,
      evidenceBoundary: "KCODER_STUDIO_MOCK route responses; history/edit state are actual mounted Mobile Web UI, no model Provider request",
    };
  });

  await runCase(p1cScenarioIds[1], {
    threadModelFixture: true,
    methodDelayMs: {},
    p1cRejectTurnStart: true,
  }, async (page, row, scenarioControl) => {
    const setupStage = `fault:${row.scenario}:preference-and-failed-send-setup`;
    network.currentStage = setupStage;
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("conversation-model-selector").click();
    await page.getByTestId("conversation-model-mock-minimax").waitFor({ state: "visible", timeout: 10_000 });
    await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "runtime.models.list" && item.stage === setupStage), 10_000, "model-picker catalog request for draft-gate setup");
    await page.getByTestId("conversation-model-mock-minimax").click();
    const highEffort = page.getByRole("radio", { name: "高", exact: true });
    await highEffort.waitFor({ state: "visible", timeout: 10_000 });
    await waitFor(() => highEffort.isEnabled(), 10_000, "preference write to settle");
    await highEffort.click();
    await waitFor(async () => (await page.getByTestId("conversation-model-selector").innerText()).includes("高"), 10_000, "high effort preference applied");
    const dialogs = page.getByRole("dialog").filter({ hasText: "模型与推理强度" });
    await dialogs.last().getByLabel("关闭", { exact: true }).click();
    await waitFor(async () => (await dialogs.count()) === 0, 10_000, "model preference dialog closed");

    const failedMessage = "P1C_REJECTED_MESSAGE_PERSISTED";
    const failedMessageFingerprint = sha256(failedMessage).slice(0, 16);
    network.currentStage = `${setupStage}:route-error`;
    const startCountBeforeReject = network.rpcEvents.filter(item => item.direction === "request" && item.method === "turn/start").length;
    await page.getByTestId("message-input").fill(failedMessage);
    await page.getByTestId("send-message").click();
    const errorRequest = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "turn/start" && item.stage === `${setupStage}:route-error`), 10_000, "actual client turn/start for failed-submission recovery fixture");
    const errorEvents = await waitFor(() => {
      const matches = network.faultFixtureEvents.filter(item => item.scenario === row.scenario && item.kind === "p1c-error-response-fixture" && item.requestIdFingerprint === errorRequest.rpcIdFingerprint && item.stage === errorRequest.stage);
      return matches.length === 1 ? matches : null;
    }, 10_000, "exactly one same-request-id P1-C error fixture event");
    assert.equal(errorEvents.length, 1, "one error fixture event must correlate to the actual send request");
    const [errorEvent] = errorEvents;
    const errorRequestIdentity = network.faultFixtureEvents.find(item => item.scenario === row.scenario && item.kind === "turn-start-request" && item.rpcIdFingerprint === errorRequest.rpcIdFingerprint && item.stage === errorRequest.stage);
    assert.ok(errorRequestIdentity?.clientMessageIdFingerprint, "the actual failed send must carry a clientMessageId identity");
    assert.equal(errorEvent.clientMessageIdFingerprint, errorRequestIdentity.clientMessageIdFingerprint, "route error fixture must map to the exact failed clientMessageId");
    assert.equal(errorEvent.routeSocketId, errorRequest.routeSocketId, "error fixture must remain on the actual request socket");
    const errorResponses = network.rpcEvents.filter(item => item.direction === "response-forwarded" && item.method === "turn/start" && item.rpcIdFingerprint === errorRequest.rpcIdFingerprint && item.stage === errorRequest.stage && item.ok === false && item.responseSource === "p1c test-generated JSON-RPC error fixture");
    assert.equal(errorResponses.length, 1, "exactly one correlated error response must reach the app WebSocketMock");
    assert.equal(errorResponses[0].routeSocketId, errorRequest.routeSocketId, "the only error response must use the originating request socket");
    const failedCardBeforeReentry = page.getByTestId("failed-submission").filter({ hasText: failedMessage });
    await failedCardBeforeReentry.getByTestId("failed-submission-error").waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(sha256((await failedCardBeforeReentry.getByTestId("failed-submission-content").innerText()).trim()), sha256(failedMessage), "the actual failed client content must stay in its own card");
    assert.equal(network.rpcEvents.filter(item => item.direction === "request" && item.method === "turn/start").length - startCountBeforeReject, 1, "failed fixture setup must create exactly one real client turn/start");

    const draft = "P1C_SEPARATE_COMPOSER_DRAFT_RETAINED";
    await page.getByTestId("message-input").fill(draft);
    await waitFor(async () => page.evaluate(expected => Object.keys(localStorage).some(key => {
      try { return JSON.parse(localStorage.getItem(key) || "null")?.composerDraft === expected; }
      catch { return false; }
    }), draft), 5_000, "separate composer draft persisted before task re-entry");
    await page.getByRole("button", { name: "返回" }).click();
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 10_000 });
    await ensureFixtureSessionVisible(page);
    await waitForGatewayRpcQuiescence(network, 15_000, 100);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    await ensureFixtureSessionVisible(page);

    scenarioControl.methodDelayMs["runtime.models.list"] = 12_000;
    const reentryStage = `fault:${row.scenario}:reentry-with-config-held`;
    network.currentStage = reentryStage;
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    const modelsRequest = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "runtime.models.list" && item.stage === reentryStage), 10_000, "runtime.models.list request while restoring persisted task state");
    assert.equal(network.rpcEvents.some(item => item.direction === "response-forwarded" && item.method === "runtime.models.list" && item.rpcIdFingerprint === modelsRequest.rpcIdFingerprint && item.stage === reentryStage), false, "configuration response remains pending while mounted task state is inspected");
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-input").waitFor({ state: "visible", timeout: 10_000 });
    const failedCard = page.getByTestId("failed-submission").filter({ hasText: failedMessage });
    await failedCard.getByTestId("failed-submission-content").waitFor({ state: "visible", timeout: 10_000 });
    await failedCard.getByTestId("failed-submission-error").waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(sha256((await failedCard.getByTestId("failed-submission-content").innerText()).trim()), sha256(failedMessage), "the same failed content must be restored in the mounted task after reload");
    assert.equal(sha256(await page.getByTestId("message-input").inputValue()), sha256(draft), "the separate unsent draft must be restored in the mounted composer");
    assert.equal(await page.getByTestId("message-input").isEnabled(), true, "composer stays editable while configuration restore is pending");
    assert.equal(await page.getByTestId("send-message").isDisabled(), true, "new writes stay disabled while configuration restore is pending");
    const retryButton = failedCard.getByTestId("retry-failed-submission");
    await retryButton.waitFor({ state: "visible", timeout: 10_000 });
    const retryButtonDisabledWhileConfigurationPending = await retryButton.isDisabled();
    const turnStartCountBeforeRetryObservation = network.rpcEvents.filter(item => item.direction === "request" && item.method === "turn/start" && item.stage === reentryStage).length;
    let retryCallbackGuardExercised = false;
    if (!retryButtonDisabledWhileConfigurationPending) {
      await retryButton.click();
      await page.evaluate(() => new Promise(resolveFrames => requestAnimationFrame(() => requestAnimationFrame(resolveFrames))));
      retryCallbackGuardExercised = true;
    }
    const turnStartCountAfterRetryObservation = network.rpcEvents.filter(item => item.direction === "request" && item.method === "turn/start" && item.stage === reentryStage).length;
    const retryTurnStartRequestDelta = turnStartCountAfterRetryObservation - turnStartCountBeforeRetryObservation;
    assert.equal(retryTurnStartRequestDelta, 0, "retry must not submit a new turn while required configuration is still pending");
    const modelResponse = await waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "runtime.models.list" && item.rpcIdFingerprint === modelsRequest.rpcIdFingerprint && item.stage === reentryStage), 20_000, "configuration response after its application hold");
    const modelDelay = network.websocketResponsePathDelays.find(item => item.method === "runtime.models.list" && item.rpcIdFingerprint === modelsRequest.rpcIdFingerprint && item.stage === reentryStage);
    assertApplicationDelay(modelDelay, 12_000, "configuration restore application hold");
    assert.ok(modelResponse, "configuration restore must eventually complete");
    row.checks = {
      ...row.checks,
      failedSubmissionMessageFingerprint: failedMessageFingerprint,
      failedFixtureRequestIdFingerprint: errorRequest.rpcIdFingerprint,
      failedFixtureClientMessageIdFingerprint: errorEvent.clientMessageIdFingerprint,
      failedFixtureRouteSocketId: errorEvent.routeSocketId,
      failedSubmissionRestored: true,
      separateComposerDraftFingerprint: sha256(draft).slice(0, 16),
      composerEditableWhileConfigurationPending: true,
      sendDisabledWhileConfigurationPending: true,
      retryButtonDisabledWhileConfigurationPending,
      retryCallbackGuardExercised,
      retryTurnStartRequestDelta,
      configurationRequestIdFingerprint: modelsRequest.rpcIdFingerprint,
      configurationResponseCompleted: Boolean(modelResponse),
      configurationAppliedDelayMs: modelDelay.appliedDelayMs,
      evidenceBoundary: "route-injected JSON-RPC error and KCODER_STUDIO_MOCK model list; test validates mounted Mobile state, not app-server rejection or Provider behavior",
    };
  });

  await runCase(p1cScenarioIds[2], {
    p1cBufferedNotificationFixture: true,
  }, async (page, row) => {
    const stage = `fault:${row.scenario}:initial-thread-read`;
    network.currentStage = stage;
    await page.getByTestId(`thread-${THREAD_ID}`).click();
    const readRequest = await waitFor(
      () => network.rpcEvents.find(item => item.direction === "request" && item.method === "thread/read" && item.stage === stage),
      10_000,
      "real TaskRuntime thread/read request before first mounted history",
    );
    const injectedFrames = await waitFor(() => {
      const frames = network.faultFixtureEvents.filter(item => item.scenario === row.scenario && item.kind === "p1c-buffered-notification-fixture" && item.routeSocketId === readRequest.routeSocketId && item.stage === stage);
      return frames.length === 5 ? frames : null;
    }, 10_000, "five ordered route-injected notifications while thread/read is unresolved");
    const readResponse = await waitFor(
      () => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "thread/read" && item.rpcIdFingerprint === readRequest.rpcIdFingerprint && item.routeSocketId === readRequest.routeSocketId && item.stage === stage),
      15_000,
      "the same thread/read response after test protocol notifications",
    );
    assert.deepEqual(injectedFrames.map(item => [item.sequence, item.method]), [
      [1, "turn/started"],
      [2, "item/started"],
      [3, "item/delta"],
      [4, "item/completed"],
      [5, "turn/completed"],
    ], "route fixture notifications must preserve the intended sequence order");
    assert.ok(injectedFrames.every(item => item.atMs < readResponse.atMs), "all route fixture frames must arrive before the matching history response is forwarded");
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });
    const assistant = page.getByTestId("message-assistant").filter({ hasText: "P1C_BUFFERED_VISIBLE_ASSISTANT_TEXT" });
    await assistant.waitFor({ state: "visible", timeout: 10_000 });
    const assistantText = await assistant.last().innerText();
    assert.ok(assistantText.includes("P1C_BUFFERED_VISIBLE_ASSISTANT_TEXT"), "buffered route fixture delta must reach visible mounted assistant text");
    await page.getByTestId("stop-turn").waitFor({ state: "hidden", timeout: 5_000 });
    const fixtureEvents = network.faultFixtureEvents.filter(item => item.scenario === row.scenario && item.kind === "p1c-buffered-notification-fixture" && item.stage === stage);
    row.checks = {
      ...row.checks,
      threadReadRequestIdFingerprint: readRequest.rpcIdFingerprint,
      routeSocketId: readRequest.routeSocketId,
      notificationSequence: fixtureEvents.map(item => item.sequence),
      notificationMethods: fixtureEvents.map(item => item.method),
      allNotificationsPrecededThreadReadForwarding: true,
      visibleAssistantMarkerFingerprint: sha256("P1C_BUFFERED_VISIBLE_ASSISTANT_TEXT").slice(0, 16),
      visibleAssistantRow: true,
      terminalUiSettled: true,
      fixtureEvidenceBoundary: "these ordered JSON-RPC notifications are injected at the Playwright WebSocket route during a real mounted TaskRuntime thread/read; they are not Rust app-server/Engine-originated events",
    };
  });

  await runCase(p1cScenarioIds[3], {}, async (_unused, row) => {
    const runReconnectCase = async (caseName, knownTurn) => {
      const subScenario = `${row.scenario}:${caseName}`;
      const stage = `fault:${subScenario}:reconnect`;
      const control = {
        delayMs: 0,
        scenarioId: subScenario,
        methodDelayMs: {},
        p1cActiveRunSummary: createP1CActiveRunSummary(),
        disconnectAfterMethodResponse: "thread/read",
        ...(knownTurn ? { p1cStartedTurnFixture: true } : {}),
      };
      network.currentStage = stage;
      const owningPageId = network.applicationPageSequence + 1;
      const page = await newMobilePage(chromium, network, control, gatewayCalls, browserErrors, context);
      try {
        await connectMobile(page, gateway);
        await ensureFixtureSessionVisible(page);
        await page.getByTestId(`thread-${THREAD_ID}`).click();
        const firstRead = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "thread/read" && item.stage === stage && network.routedWebSocketConnections.some(connection => connection.id === item.routeSocketId && connection.owningPageId === owningPageId)), 10_000, `${caseName} initial thread/read request`);
        const closed = await waitFor(() => network.faultFixtureEvents.find(item => item.scenario === subScenario && item.kind === "socket-closed-after-response" && item.method === "thread/read" && item.routeSocketId === firstRead.routeSocketId), 15_000, `${caseName} fixture disconnect after initial history`);
        const replacementInitialize = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "initialize" && item.stage === stage && item.routeSocketId !== firstRead.routeSocketId && network.routedWebSocketConnections.some(connection => connection.id === item.routeSocketId && connection.owningPageId === owningPageId)), 25_000, `${caseName} initialize on replacement route`);
        const replacementRead = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "thread/read" && item.stage === stage && item.routeSocketId === replacementInitialize.routeSocketId), 20_000, `${caseName} authoritative history read on replacement route`);
        await waitFor(() => network.rpcEvents.find(item => item.direction === "response-forwarded" && item.method === "thread/read" && item.rpcIdFingerprint === replacementRead.rpcIdFingerprint && item.routeSocketId === replacementRead.routeSocketId && item.stage === stage), 20_000, `${caseName} replacement history response`);
        await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 10_000 });
        await page.getByTestId("message-user").first().waitFor({ state: "visible", timeout: 10_000 });
        await page.getByTestId("stop-turn").waitFor({ state: "visible", timeout: 10_000 });
        const stop = page.getByTestId("stop-turn");
        if (knownTurn) {
          await stop.click();
          const interrupt = await waitFor(() => network.rpcEvents.find(item => item.direction === "request" && item.method === "turn/interrupt" && item.stage === stage && item.routeSocketId === replacementInitialize.routeSocketId), 10_000, "known turn interrupt request on the replacement route");
          assert.equal(interrupt.threadIdFingerprint, sha256(THREAD_ID).slice(0, 16), "known active turn stop must target the exact resumed thread");
          assert.equal(interrupt.turnIdFingerprint, sha256("p1c-reconnect-known-turn").slice(0, 16), "known active turn stop must target the exact pre-disconnect turn ID");
          return {
            firstRouteSocketId: firstRead.routeSocketId,
            replacementRouteSocketId: replacementInitialize.routeSocketId,
            disconnectObserved: Boolean(closed),
            knownTurnStartObserved: true,
            interruptRequestIdFingerprint: interrupt.rpcIdFingerprint,
            interruptThreadIdFingerprint: interrupt.threadIdFingerprint,
            interruptTurnIdFingerprint: interrupt.turnIdFingerprint,
            interruptOnReplacementRoute: interrupt.routeSocketId !== firstRead.routeSocketId,
            fixtureEvidenceBoundary: "the running summary and turn/started are test-generated route fixtures; this proves the mounted client preserves/targets an observed turn ID, not Gateway or Engine interrupt acceptance",
          };
        }
        await stop.click();
        await page.evaluate(() => new Promise(resolveAnimation => requestAnimationFrame(() => requestAnimationFrame(resolveAnimation))));
        const guessedInterrupts = network.rpcEvents.filter(item => item.direction === "request" && item.method === "turn/interrupt" && item.stage === stage);
        assert.equal(guessedInterrupts.length, 0, "when an authoritative active summary has no observed turn ID, the client must not invent an interrupt target");
        return {
          firstRouteSocketId: firstRead.routeSocketId,
          replacementRouteSocketId: replacementInitialize.routeSocketId,
          disconnectObserved: Boolean(closed),
          knownTurnStartObserved: false,
          interruptRequestCount: guessedInterrupts.length,
          noGuessedTurnId: true,
          fixtureEvidenceBoundary: "the active summary is test-generated at the isolated WebSocket route; this validates safe client behavior without asserting a real resident runtime state",
        };
      } finally {
        if (!page.isClosed()) await page.close().catch(() => {});
      }
    };

    const known = await runReconnectCase("known-turn", true);
    const unknown = await runReconnectCase("unknown-turn-id", false);
    row.checks = {
      ...row.checks,
      knownTurn: known,
      unknownTurn: unknown,
      boundary: "mounted Mobile client protocol fixture only; no real Gateway or Rust Engine active-turn ownership/interrupt acceptance claim",
    };
  }, { skipPageSetup: true });

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
      if (pairingPage && !pairingPage.isClosed()) await pairingPage.close().catch(() => {});
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
          if (!page.isClosed()) await page.close().catch(() => {});
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

  return { rows, requiredScenarioFailures, fixtureReceiptLedger: receiptSummary };
}

async function newMobilePage(chromium, network, delayControl, gatewayCalls, browserErrors, context, storageState) {
  const page = await chromium.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
    ...(storageState ? { storageState } : {}),
  });
  const pageId = ++network.applicationPageSequence;
  await installPageInstrumentation(page, pageId);
  await installNetworkInstrumentation(page, pageId, network, delayControl, gatewayCalls);
  page.on("pageerror", error => browserErrors.push(context.redactText(error.message).slice(0, 500)));
  page.on("requestfailed", request => {
    const pathname = safePath(request.url());
    network.failedRequests[pathname] = (network.failedRequests[pathname] ?? 0) + 1;
  });
  return page;
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
      const requestStartedAtMs = round(performance.now());
      const requestStartedAtEpochMs = round(epochNow());
      ledger.httpRouteRequests.push({
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
    for (const timer of methodResponseHoldTimers) clearTimeout(timer);
    methodResponseHoldTimers.clear();
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
          if (frame.method === "turn/start" && delayControl.p1cRejectTurnStart === true) {
            const request = pendingRpc.get(String(frame.id));
            const errorFrame = createP1CTurnStartErrorFixtureFrame(frame);
            socket.send(JSON.stringify(errorFrame));
            const deliveredAt = performance.now();
            const event = {
              scenario: delayControl.scenarioId ?? "unspecified",
              kind: "p1c-error-response-fixture",
              source: "test-generated JSON-RPC error at Playwright WebSocket route; bypasses KCODER_STUDIO_MOCK runMock",
              requestIdFingerprint: request.rpcIdFingerprint,
              clientMessageIdFingerprint: typeof frame.params?.clientMessageId === "string" ? sha256(frame.params.clientMessageId).slice(0, 16) : null,
              threadIdFingerprint: request.threadIdFingerprint,
              routeSocketId,
              requestIdPreserved: errorFrame.id === frame.id,
              stage: request.stage,
              atMs: round(deliveredAt),
            };
            ledger.websocketFrames += 1;
            ledger.faultFixtureEvents.push(event);
            ledger.rpc.push({
              method: "turn/start",
              rpcIdFingerprint: request.rpcIdFingerprint,
              actionId: request.actionId,
              routeSocketId,
              ...routeInfo,
              durationMs: round(deliveredAt - request.sentAt),
              configuredDelayMs: 0,
              responsePathAppliedDelayMs: 0,
              requestSentAtEpochMs: round(request.sentAtEpochMs),
              responseForwardedAtEpochMs: round(epochNow()),
              ok: false,
              responseSource: "p1c test-generated JSON-RPC error fixture",
              timingBoundary: "test-side route response delivery; not an app-server rejection",
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
              responseSource: "p1c test-generated JSON-RPC error fixture",
            });
            pendingRpc.delete(String(frame.id));
            ledger.pendingRpcMethodCounts[frame.method] = Math.max(0, (ledger.pendingRpcMethodCounts[frame.method] ?? 1) - 1);
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
      if (delayControl.p1cActiveRunSummary && request && ["thread/read", "thread/resume"].includes(request.method) && frame?.result?.thread) {
        frame = {
          ...frame,
          result: {
            ...frame.result,
            thread: {
              ...frame.result.thread,
              status: "running",
              runSummary: { ...delayControl.p1cActiveRunSummary },
            },
          },
        };
        ledger.faultFixtureEvents.push({
          scenario: delayControl.scenarioId ?? "unspecified",
          kind: "p1c-active-run-summary-fixture",
          method: request.method,
          threadIdFingerprint: request.threadIdFingerprint,
          routeSocketId,
          mainTurn: delayControl.p1cActiveRunSummary.mainTurn,
          source: "test-generated thread summary patch at Playwright WebSocket route",
          stage: request.stage,
          atMs: round(receivedAt),
        });
      }
      if (request?.method === "thread/read" && delayControl.p1cBufferedNotificationFixture === true && !delayControl.p1cBufferedNotificationInjected) {
        const frames = createP1CBufferedNotificationFrames({ serverId: SERVER_ID, threadId: THREAD_ID });
        delayControl.p1cBufferedNotificationInjected = true;
        frames.forEach((notification, index) => {
          socket.send(JSON.stringify(notification));
          ledger.websocketFrames += 1;
          ledger.faultFixtureEvents.push({
            scenario: delayControl.scenarioId ?? "unspecified",
            kind: "p1c-buffered-notification-fixture",
            source: "test-generated ordered notification at Playwright WebSocket route before thread/read result; not Engine-originated",
            method: notification.method,
            sequence: notification.params.sequence,
            frameIndex: index + 1,
            threadIdFingerprint: sha256(THREAD_ID).slice(0, 16),
            turnIdFingerprint: sha256(notification.params.turnId).slice(0, 16),
            routeSocketId,
            stage: request.stage,
            atMs: round(performance.now()),
          });
        });
      }
      if (request?.method === "thread/read" && delayControl.p1cStartedTurnFixture === true && !delayControl.p1cStartedTurnInjected) {
        const notification = createP1CStartedTurnFrame({ serverId: SERVER_ID, threadId: THREAD_ID });
        delayControl.p1cStartedTurnInjected = true;
        socket.send(JSON.stringify(notification));
        ledger.websocketFrames += 1;
        ledger.faultFixtureEvents.push({
          scenario: delayControl.scenarioId ?? "unspecified",
          kind: "p1c-started-turn-fixture",
          source: "test-generated turn/started notification at Playwright WebSocket route before thread/read result; not Engine-originated",
          method: notification.method,
          sequence: notification.params.sequence,
          threadIdFingerprint: sha256(THREAD_ID).slice(0, 16),
          turnIdFingerprint: sha256(notification.params.turnId).slice(0, 16),
          routeSocketId,
          stage: request.stage,
          atMs: round(performance.now()),
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
            ledger.faultFixtureEvents.push({ scenario: delayControl.scenarioId ?? "unspecified", kind: "socket-closed-after-response", method, routeSocketId, stage: ledger.currentStage });
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
      return { key, samples: entries.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: values.length ? values.at(-1) : null };
    });
  };
  return {
      httpByPath: group(network.http),
      httpRouteRequests: network.httpRouteRequests,
      httpResponsePathResponses: network.httpResponsePathDelays.map(item => ({
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
