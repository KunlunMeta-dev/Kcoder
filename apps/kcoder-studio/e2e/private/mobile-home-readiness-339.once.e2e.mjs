import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { copyOfficialMobileStaticDist, inspectOfficialMobileStaticDist } from "../harness/mobile-static-dist-input.mjs";
import { addOfficialMobileExportPostflight, readOfficialMobileExportReceipt } from "../harness/official-mobile-export-receipt.mjs";
import {
  CURRENT_ARCHIVED_BUNDLE_EVIDENCE,
  currentArchivedBundleRequested,
  inspectCurrentArchivedMobileWeb,
  validateCurrentArchivedGateway,
} from "../harness/current-mobile-web-archive.mjs";
import { appRoot, repoRoot, runE2E } from "../harness/run-context.mjs";

const GATEWAY_SNAPSHOT = "target/test/apps/kcoder-studio/e2e/private/mobile-gateway-runtime-freeze-current.once.e2e.mjs/20261009-194714.000Z/artifacts/gateway-runtime-frozen";
const OFFICIAL_EXPORT = {
  receiptPath: resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/private/mobile-web-export-9925461c.once.e2e.mjs/20261009-181452.098Z/artifacts/official-mobile-web-export-9925461c.json"),
  receiptSha256: "375eb4c038da738edb3aa6267b3500a930928051f25c5d17a9905176a01d3ef7",
  runManifestSha256: "8100981519df028f3f98ef4a10318b6a9ca3a661e0e1729053b244958933f4f8",
};
const OFFICIAL_SOURCE_OPTIONS = Object.freeze({
  sourceSnapshotRoot: resolve(repoRoot, "target/private-official-export-receipt-wiring-20261009/source-adapter-9925461c"),
  sourceSnapshotManifestSha256: "7d64b37bb56592f3e33dc222af0e58bf3a2cf44b72261092c42339acd30d935e",
});
const useCurrentArchive = currentArchivedBundleRequested();
const onlyStatus401 = process.argv.includes("--only-status-401");
const EXPECTED = {
  mobileCommit: "9925461ca047031f3f7f37d1f039d986c305fec3",
  mobileGitTree: "80d41cf2979f7dab00973c6dd6e45e173734d112",
  sharedGitTree: "8270e871236a15579a2302e4b46f35642837b1be",
  mobileSourceDigest: "b22dbddabf802b08a4a586de178c875b576a8279efc51d142a6f1948e40dd020",
  webFiles: 37,
  webBundleSha256: "d32df934303a04eb919711914d71aca622897ab1f0bfac20990e235fbeab8a3c",
  webManifestSha256: "7ce760cfc9aabc14dd8fee65043c6ded400bb2f0eccf6d3f04930f8403b23d13",
  webReuseManifestSha256: "c550981f5b62a87884959fe60f7aad577b211d41aa4ca44a3b27aeb5b3541274",
  gatewaySourceSha256: "48016a39dfdf39664943e73e68623fc600762e8a65338a95cb479733a72a4074",
  gatewayMobileWebStaticSha256: "1c57090fb35ac007620021a365e805f14d16a12a5b39f192bb7bd5f0a1bc1f66",
  gatewayDependencySha256: "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954",
  gatewayFreezeSha256: "4b587547bb9866987d3d4756d2c1126777d1a19206dabc40dd39b15b786b26cd",
  gatewaySourceFiles: 71,
  nodeSha256: "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9",
  chromiumSha256: "0b20b130e7edd9dd51873be867761295fe0cfad490c2b9a64f95bd3cfc08fa71",
  chromiumVersion: "151.0.7922.34",
};

await runE2E(import.meta.url, {
  testId: useCurrentArchive
    ? (onlyStatus401 ? "mobile-p1a-401-recovery-current-archived-bundle" : "mobile-home-readiness-current-archived-bundle")
    : (onlyStatus401 ? "mobile-p1a-401-recovery-git992" : "mobile-home-readiness-git992"),
  tier: "manual-live",
  modelPolicy: useCurrentArchive
    ? "CURRENT_ARCHIVED_BUNDLE_FUNCTIONAL: archived Mobile Web export mounted in an isolated KCODER_STUDIO_MOCK Gateway; no Rust app-server, model Provider, or production service"
    : "official Git992 Mobile Web export mounted in an isolated KCODER_STUDIO_MOCK Gateway; no model Provider or production service",
  retainSuccessLogs: true,
}, async context => {
  const currentArchive = useCurrentArchive ? await inspectCurrentArchivedMobileWeb() : null;
  const officialMobileInput = useCurrentArchive ? null : await readOfficialMobileExportReceipt(OFFICIAL_EXPORT, OFFICIAL_SOURCE_OPTIONS);
  if (!useCurrentArchive) {
    assert.equal(officialMobileInput.builderCommit, EXPECTED.mobileCommit);
    assert.equal(officialMobileInput.receiptSha256, OFFICIAL_EXPORT.receiptSha256);
    assert.equal(officialMobileInput.manifestSha256, EXPECTED.webManifestSha256);
    assert.equal(officialMobileInput.receipt.officialDeployment.resourceCount, EXPECTED.webFiles);
    assert.equal(officialMobileInput.receipt.officialDeployment.bundleSha256, EXPECTED.webBundleSha256);
    assert.equal(officialMobileInput.receipt.reuseInput.manifestSha256, EXPECTED.webReuseManifestSha256);
    addOfficialMobileExportPostflight(context, OFFICIAL_EXPORT, officialMobileInput, OFFICIAL_SOURCE_OPTIONS);
  }
  const officialMobileCopy = await copyOfficialMobileStaticDist(context, {
    distRoot: useCurrentArchive ? currentArchive.distRoot : officialMobileInput.distRoot,
    expectedManifestSha256: useCurrentArchive ? currentArchive.officialManifestSha256 : officialMobileInput.manifestSha256,
    outputName: useCurrentArchive ? "current-archived-mobile-static-dist" : "official-git992-mobile-static-dist",
  });
  const currentGatewayRuntime = useCurrentArchive ? await validateCurrentArchivedGateway() : null;
  const inputsBefore = useCurrentArchive
    ? await verifyCurrentArchivedInputs(currentArchive, officialMobileCopy, currentGatewayRuntime)
    : await verifyInputs(officialMobileInput, officialMobileCopy, OFFICIAL_SOURCE_OPTIONS);
  const workspace = context.pathInState("isolated-workspace");
  const fs = await import("node:fs/promises");
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  const serversFile = await context.writeStateJson("mock-servers.json", [{
    id: "backend4a",
    label: "Backend 4A fixture",
    runtime: "kcoder",
    transport: "local",
    command: process.execPath,
    workspace,
  }]);
  const serversStore = context.pathInState("gateway-servers-store.json");
  const gateway = useCurrentArchive
    ? await startGateway(context, {
      label: "p1a-current-archive-mock-gateway",
      gatewayRoot: currentGatewayRuntime.root,
      cwd: currentGatewayRuntime.root,
      workspace,
      serversFile,
      serversStore,
      kcoderBin: currentGatewayRuntime.binaryPath,
      auth: true,
      env: {
        KCODER_STUDIO_WEB_ROOT: "",
        KCODER_STUDIO_MOBILE_WEB_ROOT: officialMobileCopy.ownedRoot,
        KCODER_STUDIO_MOCK: "1",
      },
    })
    : await startGateway(context, {
      label: "p1a-mock-gateway",
      gatewayRoot: resolve(repoRoot, GATEWAY_SNAPSHOT),
      cwd: resolve(repoRoot, GATEWAY_SNAPSHOT),
      workspace,
      serversFile,
      serversStore,
      // KCODER_STUDIO_MOCK handles the app-server WebSocket locally; keep the
      // configured fallback deterministic without requiring a Rust executable.
      kcoderBin: resolve(repoRoot, "target/debug/kcoder"),
      auth: true,
      env: {
        KCODER_STUDIO_WEB_ROOT: "",
        KCODER_STUDIO_MOBILE_WEB_ROOT: officialMobileCopy.ownedRoot,
        KCODER_STUDIO_MOCK: "1",
      },
    });
  const chromium = await startChromium(context, {
    label: "p1a-home-readiness-chromium",
    executablePath: "/opt/cft/chrome-linux64/chrome",
    noSandbox: true,
  });
  assert.equal(await chromium.browser.version(), EXPECTED.chromiumVersion);
  const rows = [];

  if (onlyStatus401) {
    rows.push(await recordScenario(context, "p1a-scenario-03-status-401-reauthorization.json", () => runStatusFailure(context, chromium, gateway, 401)));
  } else {
    rows.push(await recordScenario(context, "p1a-scenario-01-held-status-new-navigation.json", () => runHeldStatusNavigation(chromium, gateway)));
    rows.push(await recordScenario(context, "p1a-scenario-02-status-503-local-error.json", () => runStatusFailure(context, chromium, gateway, 503)));
    rows.push(await recordScenario(context, "p1a-scenario-03-status-401-reauthorization.json", () => runStatusFailure(context, chromium, gateway, 401)));
  }

  const inputsAfter = useCurrentArchive
    ? await verifyCurrentArchivedInputs(await inspectCurrentArchivedMobileWeb(), officialMobileCopy, await validateCurrentArchivedGateway())
    : await verifyInputs(officialMobileInput, officialMobileCopy, OFFICIAL_SOURCE_OPTIONS);
  assert.deepEqual(inputsAfter, inputsBefore, "frozen Mobile, export, Gateway, and executable inputs changed during the run");
  await context.writeArtifactJson("p1a-home-readiness-summary.json", {
    schemaVersion: 1,
    result: rows.every(row => row.status === "PASS") ? "PASS" : "FAIL",
    runScope: onlyStatus401 ? "single status-401 authorization-refresh recovery scenario; other P1-A scenarios retain separate prior run evidence" : "three mounted Home readiness scenarios",
    evidenceBoundary: useCurrentArchive
      ? `${CURRENT_ARCHIVED_BUNDLE_EVIDENCE}: archive aggregate plus five recorded product pins; not full current Git source, native-device, or public-Relay evidence; KCODER_STUDIO_MOCK means no Rust app-server or Provider`
      : "local Chromium mobile viewport + isolated mock Gateway; official Git992 Mobile source, not native-device or public-Relay evidence",
    scenarios: rows,
    inputsBefore,
    inputsAfter,
    browser: {
      version: await chromium.browser.version(),
      executablePath: chromium.executablePath,
      viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    },
    gateway: {
      pid: gateway.child.pid,
      port: gateway.port,
      mock: true,
      ...(useCurrentArchive ? { rustBinaryExecuted: false } : {}),
    },
    noProviderRequests: true,
  });
  assert.ok(rows.every(row => row.status === "PASS"), "one or more P1-A mounted readiness scenarios failed; see per-scenario artifacts");
});

async function runHeldStatusNavigation(chromium, gateway) {
  const page = await mobilePage(chromium);
  const events = [];
  let release;
  let statusStarted;
  let holdSettledResolve;
  const started = new Promise(resolveStarted => { statusStarted = resolveStarted; });
  const held = new Promise(resolveHeld => { release = resolveHeld; });
  const holdSettled = new Promise(resolveSettled => { holdSettledResolve = resolveSettled; });
  let holdActive = false;
  await page.route("**/api/servers/status", async route => {
    const pathname = new URL(route.request().url()).pathname;
    const startedAt = Date.now();
    if (!holdActive) {
      holdActive = true;
      statusStarted({ startedAt, pathname });
      try {
        const upstream = await route.fetch();
        const upstreamStatus = upstream.status();
        await waitUntilEpoch(startedAt + 12_000);
        await held;
        const appliedDelayMs = Date.now() - startedAt;
        events.push({ pathname, method: route.request().method(), upstreamStatus, appliedDelayMs });
        try { await route.fulfill({ response: upstream }); } catch { /* navigation can cancel the held browser request */ }
      } catch (error) {
        events.push({ pathname, method: route.request().method(), errorName: error?.name || "Error" });
        try { await route.abort(); } catch { /* request can already be closed */ }
      } finally {
        holdSettledResolve();
      }
      return;
    }
    await route.continue();
  });
  const responseEvents = captureRelevantResponses(page, gateway.baseUrl);
  try {
    const mobileEntry = await connectHome(page, gateway);
    const pending = await started;
    await page.getByTestId("server-status-refreshing").waitFor({ state: "visible", timeout: 8_000 });
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 8_000 });
    await ensureThreadVisible(page);
    assert.equal(await page.getByTestId("server-status-error").isVisible().catch(() => false), false, "held status request should not show an error");
    const heldBeforeClick = holdActive && events.length === 0;
    assert.equal(heldBeforeClick, true, "status response must still be held before New is clicked");
    await page.getByTestId("new-workspace").click();
    await page.getByTestId("new-workspace-prompt").waitFor({ state: "visible", timeout: 10_000 });
    const clickNavigated = new URL(page.url()).pathname.endsWith("/new") || await page.getByTestId("new-workspace-prompt").isVisible();
    assert.equal(clickNavigated, true, "New click should mount the new-workspace route while status remains pending");
    assert.equal(events.length, 0, "status response must remain pending through the New route transition");
    await waitUntilEpoch(pending.startedAt + 12_000);
    release();
    await holdSettled;
    const measuredElapsedMs = events[0]?.appliedDelayMs;
    assert.ok(measuredElapsedMs >= 12_000, `status response was held only ${measuredElapsedMs}ms`);
    await page.waitForTimeout(100);
    return {
      scenario: "status-12s-held-new-navigation",
      status: "PASS",
      statusRequest: { ...pending, configuredHoldMs: 12_000, measuredElapsedMs },
      mobileEntry,
      statusResponses: responseEvents.filter(item => item.pathname === "/api/servers/status"),
      refreshResponses: responseEvents.filter(item => item.pathname === "/api/mobile/session/refresh"),
      statusRefreshingVisible: true,
      serverAndThreadVisibleBeforeClick: true,
      newWorkspaceVisibleBeforeClick: true,
      newClickMountedRoute: true,
      heldResponseReleasedAfterNavigation: true,
      holdEvidence: events,
    };
  } finally {
    release();
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}

async function runStatusFailure(context, chromium, gateway, statusCode) {
  const page = await mobilePage(chromium);
  const responses = captureRelevantResponses(page, gateway.baseUrl);
  const requestDiagnostics = captureStatusFailureRequests(page, gateway.baseUrl);
  const recovery = {
    exact401RefreshRetrySequence: null,
    injectionDisabledAfterSequence: false,
    reauthorizationSessionCreated: false,
    freshServerList200: false,
    sessionBootstrapInventoryValid: false,
    sessionBootstrapEvidence: null,
    serverInventorySource: null,
    freshServerInventoryAvailable: false,
    freshStatus200: false,
    sameProfileIdentityRetained: false,
    sameServerAndThreadRestored: false,
    restoredThreadClickMountedTaskRoute: false,
  };
  const gatewayOrigin = new URL(gateway.baseUrl).origin;
  const successfulStatus = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === gatewayOrigin && url.pathname === "/api/servers/status" && response.status() === 200;
  }, { timeout: 15_000 });
  void successfulStatus.catch(() => {});
  let mobileEntry = null;
  let failureInjectionActive = false;
  let reloadNavigation = null;
  let remainingFailureResponses = statusCode === 401 ? Number.POSITIVE_INFINITY : 1;
  await page.route("**/api/servers/status", async route => {
    const requestOrigin = new URL(route.request().url()).origin;
    if (requestOrigin !== gatewayOrigin) {
      requestDiagnostics.recordStatusRoute({ originMatched: false, injectionActive: failureInjectionActive, action: "continue" });
      await route.continue();
      return;
    }
    if (failureInjectionActive && remainingFailureResponses > 0) {
      if (statusCode !== 401) remainingFailureResponses -= 1;
      requestDiagnostics.recordStatusRoute({ originMatched: true, injectionActive: true, action: "fulfill", status: statusCode });
      await route.fulfill({
        status: statusCode,
        contentType: "application/json",
        body: JSON.stringify({ error: statusCode === 401 ? "reauthorization-required" : "status-unavailable" }),
      });
      return;
    }
    requestDiagnostics.recordStatusRoute({ originMatched: true, injectionActive: failureInjectionActive, action: "continue" });
    await route.continue();
  });
  try {
    mobileEntry = await connectHome(page, gateway);
    requestDiagnostics.setPhase("initial-status");
    await successfulStatus;
    const originalProfileId = statusCode === 401 ? profileIdFromUrl(page.url()) : null;
    failureInjectionActive = true;
    requestDiagnostics.setPhase("injection-armed");
    const injectedSequenceStart = responses.length;
    const injectedResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === gatewayOrigin && url.pathname === "/api/servers/status" && response.status() === statusCode;
    }, { timeout: 15_000 });
    void injectedResponse.catch(() => {});
    const pathBeforeReload = safeDiagnosticPath(new URL(page.url()).pathname);
    requestDiagnostics.setPhase("reload-navigation");
    try {
      const navigationResponse = await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      reloadNavigation = {
        pathBeforeReload,
        pathAfterReload: safeDiagnosticPath(new URL(page.url()).pathname),
        responseStatus: navigationResponse?.status() ?? null,
        responsePath: navigationResponse ? safeDiagnosticPath(new URL(navigationResponse.url()).pathname) : null,
        responseIsGatewayOrigin: navigationResponse ? new URL(navigationResponse.url()).origin === gatewayOrigin : null,
      };
    } catch (error) {
      reloadNavigation = {
        pathBeforeReload,
        pathAfterReload: safeDiagnosticPath(new URL(page.url()).pathname),
        errorName: error?.name || "Error",
      };
      throw error;
    }
    requestDiagnostics.setPhase("waiting-for-injected-status");
    await injectedResponse;
    requestDiagnostics.setPhase("reauthorization-ui");
    let serverVisible = null;
    let threadVisible = null;
    let newVisible = null;
    if (statusCode === 503) {
      await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
      await ensureThreadVisible(page);
      serverVisible = await page.getByTestId("toggle-server-backend4a").isVisible().catch(() => false);
      threadVisible = await page.getByTestId("thread-mock-active-session").isVisible().catch(() => false);
      newVisible = await page.getByTestId("new-workspace").isVisible().catch(() => false);
      assert.equal(serverVisible && threadVisible && newVisible, true, "503 must not hide the server, thread, or New entry");
      await page.getByTestId("server-status-error").waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await page.getByTestId("reauthorize-active-profile").isVisible().catch(() => false), false, "503 should remain a local status error");
    } else {
      await page.getByTestId("reauthorize-active-profile").waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(await page.getByTestId("server-status-error").isVisible().catch(() => false), false, "401 must be presented as reauthorization, not stale successful status");
      assert.equal(profileIdFromUrl(page.url()), originalProfileId, "the challenge must remain scoped to the original active profile");

      const recoverySequence = responses.slice(injectedSequenceStart)
        .filter(item => item.pathname === "/api/servers/status" || item.pathname === "/api/mobile/session/refresh")
        .map(({ method, pathname, status }) => [method, pathname, status]);
      assert.deepEqual(recoverySequence, [
        ["GET", "/api/servers/status", 401],
        ["POST", "/api/mobile/session/refresh", 200],
        ["GET", "/api/servers/status", 401],
      ], "reauthorization injection must observe exactly status 401 → refresh 200 → retried status 401 before recovery");
      recovery.exact401RefreshRetrySequence = recoverySequence.map(([method, path, status]) => ({ method, path, status }));

      // Only after the exact failed refresh/retry cycle is recorded may the test
      // stop injecting 401s and exercise a real same-Gateway reauthorization.
      failureInjectionActive = false;
      remainingFailureResponses = 0;
      recovery.injectionDisabledAfterSequence = true;
      await page.getByTestId("reauthorize-active-profile").click();
      const endpoint = page.getByTestId("gateway-endpoint");
      await endpoint.waitFor({ state: "visible", timeout: 15_000 });
      const endpointValue = await endpoint.inputValue();
      assert.equal(endpointValue, gateway.baseUrl, "reauthorization must target the same Gateway origin");
      await page.getByTestId("gateway-token").fill(gateway.authToken);
      const responseCursor = responses.length;
      const sessionCreated = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.origin === gatewayOrigin && url.pathname === "/api/mobile/session" && response.request().method() === "POST" && response.status() === 200;
      }, { timeout: 20_000 }).then(response => ({ response }), error => ({ error }));
      const statusRestored = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.origin === gatewayOrigin && url.pathname === "/api/servers/status" && response.request().method() === "GET" && response.status() === 200;
      }, { timeout: 20_000 }).then(response => ({ response }), error => ({ error }));
      await page.getByTestId("gateway-connect").click();
      const sessionOutcome = await sessionCreated;
      if (sessionOutcome.error) throw sessionOutcome.error;
      const bootstrapPayload = await sessionOutcome.response.json().catch(() => null);
      recovery.reauthorizationSessionCreated = true;
      const bootstrapEvidence = projectInitialServerBootstrap(bootstrapPayload, "backend4a");
      recovery.sessionBootstrapEvidence = bootstrapEvidence;
      recovery.sessionBootstrapInventoryValid = bootstrapEvidence.capabilityAdvertised &&
        bootstrapEvidence.schemaValid && bootstrapEvidence.expectedServerPresent;
      if (recovery.sessionBootstrapInventoryValid) {
        recovery.serverInventorySource = "reauthorization-session-bootstrap";
        recovery.freshServerInventoryAvailable = true;
      } else {
        const capturedList = responses.slice(responseCursor).find(item =>
          item.pathname === "/api/servers" && item.method === "GET" && item.status === 200);
        if (!capturedList) {
          const listOutcome = await page.waitForResponse(response => {
            const url = new URL(response.url());
            return url.origin === gatewayOrigin && url.pathname === "/api/servers" &&
              response.request().method() === "GET" && response.status() === 200;
          }, { timeout: 20_000 }).then(response => ({ response }), error => ({ error }));
          if (listOutcome.error) throw listOutcome.error;
        }
        recovery.serverInventorySource = "same-origin-api-get";
        recovery.freshServerList200 = true;
        recovery.freshServerInventoryAvailable = true;
      }
      const statusOutcome = await statusRestored;
      if (statusOutcome.error) throw statusOutcome.error;
      recovery.freshStatus200 = true;
      assert.equal(recovery.freshServerInventoryAvailable, true, "reauthorization must restore the expected authorized server inventory by a valid session bootstrap or a same-origin list GET");
      const newWorkspaceCheck = await inspectUniqueVisibleTestId(page, "new-workspace");
      recovery.newWorkspaceDom = newWorkspaceCheck.snapshot;
      recovery.newWorkspaceVisibleCount = newWorkspaceCheck.visibleCount;
      assert.equal(newWorkspaceCheck.visibleCount, 1, "reauthorization Home must have exactly one visible New action; inspect its passive DOM snapshot if duplicate screens remain");
      await newWorkspaceCheck.locator.waitFor({ state: "visible", timeout: 30_000 });
      const restoredProfileId = profileIdFromUrl(page.url());
      assert.equal(restoredProfileId, originalProfileId, "reauthorization to the same Gateway must retain the existing profile identity");
      recovery.sameProfileIdentityRetained = true;
      const restoredServer = await inspectUniqueVisibleTestId(page, "toggle-server-backend4a");
      recovery.serverDom = restoredServer.snapshot;
      recovery.serverVisibleCount = restoredServer.visibleCount;
      assert.equal(restoredServer.visibleCount, 1, "reauthorized profile must expose exactly one visible expected server control");
      if ((await restoredServer.locator.getAttribute("aria-expanded")) !== "true") await restoredServer.locator.click();
      const restoredThreadCheck = await inspectUniqueVisibleTestId(page, "thread-mock-active-session");
      recovery.threadDom = restoredThreadCheck.snapshot;
      recovery.threadVisibleCount = restoredThreadCheck.visibleCount;
      assert.equal(restoredThreadCheck.visibleCount, 1, "reauthorized profile must expose exactly one visible expected thread");
      const restoredThread = restoredThreadCheck.locator;
      await restoredThread.waitFor({ state: "visible", timeout: 20_000 });
      const restoredServerVisible = true;
      const restoredThreadVisible = true;
      assert.equal(restoredServerVisible && restoredThreadVisible, true, "the original server and thread must return after reauthorization");
      recovery.sameServerAndThreadRestored = true;

      await restoredThread.click();
      await page.getByTestId("task-header").waitFor({ state: "visible", timeout: 20_000 });
      await page.getByTestId("message-list").waitFor({ state: "visible", timeout: 20_000 });
      const taskRoute = taskRouteFromUrl(page.url());
      assert.equal(taskRoute.profileId, originalProfileId, "the restored thread click must remain under the original profile owner");
      assert.equal(taskRoute.serverId, "backend4a");
      assert.equal(taskRoute.threadId, "mock-active-session");
      assert.equal(await page.getByTestId("runtime-error-banner").isVisible().catch(() => false), false, "the restored task route must not display a runtime error");
      recovery.restoredThreadClickMountedTaskRoute = true;
      serverVisible = restoredServerVisible;
      threadVisible = restoredThreadVisible;
      newVisible = true;
    }
    const statusResponses = responses.filter(item => item.pathname === "/api/servers/status");
    const refreshResponses = responses.filter(item => item.pathname === "/api/mobile/session/refresh");
    assert.ok(statusResponses.some(item => item.status === 200), "a successful status response must precede the injected failure");
    assert.ok(statusResponses.some(item => item.status === statusCode), `expected exact injected HTTP ${statusCode}`);
    return {
      scenario: statusCode === 503 ? "status-503-local-error" : "status-401-reauthorization",
      status: "PASS",
      successfulStatusBeforeFailure: true,
      mobileEntry,
      injectedStatus: statusCode,
      serverVisible,
      threadVisible,
      newVisible,
      statusErrorVisible: statusCode === 503,
      reauthorizationVisible: statusCode === 401,
      ...(statusCode === 401 ? {
        ...recovery,
        sameGatewayOriginReauthorized: true,
        restoredTaskRouteIdentityMatches: true,
      } : {}),
      statusResponses,
      refreshResponses,
      requestDiagnostics: requestDiagnostics.snapshot(),
      reloadNavigation,
    };
  } catch (error) {
    return {
      scenario: statusCode === 503 ? "status-503-local-error" : "status-401-reauthorization",
      status: "FAIL",
      errorName: error?.name || "Error",
      error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 800),
      initialStatus200Observed: responses.some(item => item.pathname === "/api/servers/status" && item.status === 200),
      injectedStatusObserved: responses.some(item => item.pathname === "/api/servers/status" && item.status === statusCode),
      mobileEntry,
      ...(statusCode === 401 ? { recovery } : {}),
      statusResponses: responses.filter(item => item.pathname === "/api/servers/status"),
      refreshResponses: responses.filter(item => item.pathname === "/api/mobile/session/refresh"),
      requestDiagnostics: requestDiagnostics.snapshot(),
      reloadNavigation,
    };
  } finally {
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}

async function connectHome(page, gateway) {
  const gatewayOrigin = new URL(gateway.baseUrl).origin;
  const mobileResourceResponses = [];
  const recordMobileResource = response => {
    try {
      const url = new URL(response.url());
      if (url.origin !== gatewayOrigin || !url.pathname.startsWith("/mobile/")) return;
      const headers = response.headers();
      mobileResourceResponses.push({
        path: url.pathname,
        resourceType: response.request().resourceType(),
        status: response.status(),
        contentType: headers["content-type"] || null,
        contentLength: headers["content-length"] || null,
      });
    } catch { /* ignore non-URL response objects */ }
  };
  page.on("response", recordMobileResource);
  const response = await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, "Gateway should serve the official Mobile Web entry at /mobile/");
  await page.waitForLoadState("load", { timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 15_000 });
  page.off("response", recordMobileResource);
  assert.ok(mobileResourceResponses.some(row => row.resourceType === "document" && row.status === 200 && row.contentType?.includes("text/html")), "official Mobile Web document must load from Gateway /mobile/");
  assert.ok(mobileResourceResponses.some(row => row.resourceType === "script" && row.status === 200), "official Mobile Web JavaScript must load from Gateway /mobile/");
  assert.ok(mobileResourceResponses.some(row => row.resourceType === "stylesheet" && row.status === 200), "official Mobile Web stylesheet must load from Gateway /mobile/");
  assert.ok(mobileResourceResponses.every(row => row.status === 200), "every observed /mobile/ resource response must succeed");
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await ensureThreadVisible(page);
  return {
    path: "/mobile/",
    status: response.status(),
    responses: mobileResourceResponses,
    documentLoaded: mobileResourceResponses.some(row => row.resourceType === "document" && row.status === 200),
    javascriptLoaded: mobileResourceResponses.some(row => row.resourceType === "script" && row.status === 200),
    stylesheetLoaded: mobileResourceResponses.some(row => row.resourceType === "stylesheet" && row.status === 200),
    pairedWithSameGateway: true,
  };
}

async function ensureThreadVisible(page) {
  const thread = page.getByTestId("thread-mock-active-session");
  if (await thread.isVisible().catch(() => false)) return;
  const server = page.getByTestId("toggle-server-backend4a");
  await server.waitFor({ state: "visible", timeout: 20_000 });
  if ((await server.getAttribute("aria-expanded")) !== "true") await server.click();
  await thread.waitFor({ state: "visible", timeout: 20_000 });
}

async function inspectUniqueVisibleTestId(page, testId) {
  const locator = page.getByTestId(testId);
  const raw = await locator.evaluateAll(nodes => {
    const round = value => Math.round(value * 10) / 10;
    const state = (element, depth) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const testIdValue = element.getAttribute("data-testid");
      return {
        depth,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        testIdKind: testIdValue === null ? null : depth === 0 ? "target" : /home|profile/i.test(testIdValue) ? "home-or-profile" : /route|screen/i.test(testIdValue) ? "route-or-screen" : "other",
        ariaHidden: element.getAttribute("aria-hidden") === "true" ? true : element.getAttribute("aria-hidden") === "false" ? false : null,
        inert: element.hasAttribute("inert"),
        display: style.display,
        visibility: style.visibility,
        opacity: Number(style.opacity),
        pointerEvents: style.pointerEvents,
        rect: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) },
      };
    };
    const entries = nodes.slice(0, 8).map(node => {
      const chain = [];
      for (let element = node, depth = 0; element && depth < 10; element = element.parentElement, depth += 1) chain.push(state(element, depth));
      const target = chain[0];
      const hiddenByCss = chain.some(item => item.display === "none" || item.visibility === "hidden" || item.rect.width <= 0 || item.rect.height <= 0);
      return {
        connected: node.isConnected,
        visibleByLayout: node.isConnected && !hiddenByCss,
        ariaHiddenAncestor: chain.some(item => item.ariaHidden === true),
        inertAncestor: chain.slice(1).some(item => item.inert),
        target,
        ancestorChain: chain.slice(1),
      };
    });
    return {
      pathname: window.location.pathname,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      matchedCount: nodes.length,
      truncated: nodes.length > entries.length,
      entries,
    };
  });
  const visibleLocator = locator.filter({ visible: true });
  return {
    locator: visibleLocator,
    visibleCount: await visibleLocator.count(),
    snapshot: {
      path: safeDiagnosticPath(raw.pathname),
      visibilityState: raw.visibilityState,
      hasFocus: raw.hasFocus,
      matchedCount: raw.matchedCount,
      visibleCount: await visibleLocator.count(),
      truncated: raw.truncated,
      entries: raw.entries,
    },
  };
}

async function mobilePage(chromium) {
  return chromium.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
  });
}

function captureRelevantResponses(page, expectedOrigin) {
  const rows = [];
  page.on("response", response => {
    try {
      const url = new URL(response.url());
      if (url.origin === expectedOrigin && ["/api/servers/status", "/api/mobile/session/refresh", "/api/mobile/session", "/api/servers"].includes(url.pathname)) {
        rows.push({ ordinal: rows.length + 1, method: response.request().method(), pathname: url.pathname, status: response.status(), atEpochMs: Date.now() });
      }
    } catch { /* ignore non-URL response objects */ }
  });
  return rows;
}

function captureStatusFailureRequests(page, expectedOrigin) {
  const maxEvents = 128;
  const requests = [];
  const routeEvents = [];
  const navigations = [];
  const requestOrdinals = new WeakMap();
  let phase = "connect";
  let nextOrdinal = 0;
  let droppedEvents = 0;
  const append = (rows, row) => {
    if (rows.length < maxEvents) rows.push(row);
    else droppedEvents += 1;
  };
  const onRequest = request => {
    try {
      const url = new URL(request.url());
      const originMatched = url.origin === expectedOrigin;
      const pathname = safeDiagnosticPath(url.pathname);
      const isApi = pathname.startsWith("/api/");
      const isNavigation = request.isNavigationRequest();
      if (!isApi && !isNavigation) return;
      const ordinal = ++nextOrdinal;
      requestOrdinals.set(request, ordinal);
      append(requests, {
        ordinal,
        phase,
        originMatched,
        method: request.method(),
        pathname,
        resourceType: request.resourceType(),
        navigation: isNavigation,
      });
    } catch { /* keep diagnostic capture from affecting the scenario */ }
  };
  const onRequestFailed = request => {
    try {
      const url = new URL(request.url());
      if (url.origin !== expectedOrigin) return;
      const ordinal = requestOrdinals.get(request);
      const errorText = request.failure()?.errorText || "";
      append(requests, {
        ordinal: ordinal ?? null,
        phase,
        method: request.method(),
        pathname: safeDiagnosticPath(url.pathname),
        failed: true,
        errorCode: /^net::ERR_[A-Z_]{1,64}$/.test(errorText) ? errorText : "OTHER",
      });
    } catch { /* keep diagnostic capture from affecting the scenario */ }
  };
  const onResponse = response => {
    try {
      const request = response.request();
      if (!request.isNavigationRequest()) return;
      const url = new URL(response.url());
      append(navigations, {
        phase,
        originMatched: url.origin === expectedOrigin,
        pathname: safeDiagnosticPath(url.pathname),
        status: response.status(),
        resourceType: request.resourceType(),
      });
    } catch { /* keep diagnostic capture from affecting the scenario */ }
  };
  page.on("request", onRequest);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  return {
    setPhase(value) { phase = value; },
    recordStatusRoute(row) {
      append(routeEvents, { phase, pathname: "/api/servers/status", method: "GET", ...row });
    },
    snapshot() {
      return { requests, routeEvents, navigations, droppedEvents };
    },
  };
}

function safeDiagnosticPath(pathname) {
  const knownApiPaths = new Set([
    "/api/servers/status",
    "/api/mobile/session/refresh",
    "/api/mobile/session",
    "/api/servers",
  ]);
  if (knownApiPaths.has(pathname)) return pathname;
  if (pathname.startsWith("/api/")) return "/api/<other>";
  if (pathname === "/mobile" || pathname === "/mobile/") return pathname;
  if (pathname.startsWith("/mobile/")) {
    return pathname.replace(/\/h\/[^/]+/g, "/h/<profile>")
      .replace(/\/task\/[^/]+\/[^/]+/g, "/task/<server>/<thread>");
  }
  if (pathname === "/" || pathname === "/welcome" || pathname === "/pair-scan") return pathname;
  if (pathname.startsWith("/h/")) {
    return pathname.replace(/\/h\/[^/]+/g, "/h/<profile>")
      .replace(/\/task\/[^/]+\/[^/]+/g, "/task/<server>/<thread>");
  }
  return "<outside-mobile-route>";
}

function projectInitialServerBootstrap(payload, expectedServerId) {
  const capabilities = isPlainRecord(payload?.capabilities) ? payload.capabilities : null;
  const bootstrap = payload?.initialServers;
  const schemaKeys = new Set(["version", "servers"]);
  const rows = isPlainRecord(bootstrap) && Array.isArray(bootstrap.servers) ? bootstrap.servers : null;
  const schemaValid = isPlainRecord(bootstrap) &&
    Object.keys(bootstrap).every(key => schemaKeys.has(key)) &&
    bootstrap.version === 1 && rows !== null && rows.length <= 32 &&
    rows.every(isInitialServerShape) &&
    new Set(rows.map(row => row.id)).size === rows.length;
  return {
    capabilityAdvertised: capabilities?.mobileInitialServersV1 === true,
    schemaVersion: Number.isInteger(bootstrap?.version) ? bootstrap.version : null,
    schemaValid,
    serverCount: rows?.length ?? null,
    expectedServerPresent: schemaValid && rows.some(row => row.id === expectedServerId),
  };
}

function isInitialServerShape(value) {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set(["id", "label", "labelKey", "description", "runtime", "transport",
    "workspacePath", "host", "user", "port", "command", "profile", "settingsFile",
    "accountIdentity", "authorityId", "security", "chromiumBin", "chromiumNoSandbox",
    "acceptNewHostKey", "capabilities"]);
  if (Object.keys(value).some(key => !allowed.has(key)) ||
      typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id) ||
      typeof value.label !== "string" || typeof value.description !== "string" ||
      value.runtime !== "kcoder" || (value.transport !== "local" && value.transport !== "ssh")) return false;
  for (const key of ["id", "label", "description", "labelKey", "workspacePath", "host", "user", "command",
    "profile", "settingsFile", "authorityId", "chromiumBin"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 4096)) return false;
  }
  if (value.port !== undefined && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)) return false;
  for (const key of ["chromiumNoSandbox", "acceptNewHostKey"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
  }
  if (value.capabilities !== undefined && (!isPlainRecord(value.capabilities) ||
      Object.keys(value.capabilities).length > 64 || Object.keys(value.capabilities).some(key => /token|password|credential|loginOwner/i.test(key)) ||
      Object.values(value.capabilities).some(flag => typeof flag !== "boolean"))) return false;
  if (value.accountIdentity !== undefined) {
    const account = value.accountIdentity;
    if (!isPlainRecord(account) || Object.keys(account).some(key => !["principalId", "username", "role"].includes(key)) ||
        typeof account.principalId !== "string" || typeof account.username !== "string" ||
        (account.role !== undefined && account.role !== "user" && account.role !== "admin")) return false;
  }
  if (value.security !== undefined) {
    const security = value.security;
    if (!isPlainRecord(security) || Object.keys(security).some(key => key !== "identity") || !isPlainRecord(security.identity)) return false;
    const identity = security.identity;
    if (Object.keys(identity).some(key => !["mode", "username"].includes(key)) || identity.mode !== "kcoder-account" ||
        (identity.username !== undefined && typeof identity.username !== "string")) return false;
  }
  return true;
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function profileIdFromUrl(value) {
  const segments = new URL(value).pathname.split("/").filter(Boolean);
  const index = segments.indexOf("h");
  assert.ok(index >= 0 && segments[index + 1], "expected an active Home profile route");
  return decodeURIComponent(segments[index + 1]);
}

function taskRouteFromUrl(value) {
  const segments = new URL(value).pathname.split("/").filter(Boolean);
  const profileIndex = segments.indexOf("h");
  const taskIndex = segments.indexOf("task");
  assert.ok(profileIndex >= 0 && taskIndex === profileIndex + 2 && segments[taskIndex + 1] && segments[taskIndex + 2], "expected a profile-owned task route");
  return {
    profileId: decodeURIComponent(segments[profileIndex + 1]),
    serverId: decodeURIComponent(segments[taskIndex + 1]),
    threadId: decodeURIComponent(segments[taskIndex + 2]),
  };
}

async function recordScenario(context, artifactName, run) {
  let result;
  try {
    result = await run();
  } catch (error) {
    result = {
      scenario: artifactName,
      status: "FAIL",
      errorName: error?.name || "Error",
      error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 800),
    };
  }
  await context.writeArtifactJson(artifactName, result);
  return result;
}

async function verifyCurrentArchivedInputs(archive, copiedMobileDist, gatewayRuntime) {
  assert.equal(archive.evidenceClass, CURRENT_ARCHIVED_BUNDLE_EVIDENCE);
  assert.equal(archive.builderCommitIsNotCurrentSourceClaim, true);
  const ownedDist = await inspectOfficialMobileStaticDist({
    distRoot: copiedMobileDist.ownedRoot,
    expectedManifestSha256: archive.officialManifestSha256,
  });
  assert.equal(ownedDist.resourceCount, 37);
  assert.equal(ownedDist.resourceTableSha256, archive.resourceTableSha256);
  assert.equal(copiedMobileDist.sourceStableDuringCopy, true);
  assert.equal(copiedMobileDist.ownedCopyVerified, true);
  assert.equal(await realExecutableDigest(gatewayRuntime.nodeExecutable), EXPECTED.nodeSha256);
  const chromiumPath = "/opt/cft/chrome-linux64/chrome";
  assert.equal(await realExecutableDigest(chromiumPath), EXPECTED.chromiumSha256);
  const playwrightPackage = JSON.parse(await readFile(resolve(appRoot, "renderer/node_modules/@playwright/test/package.json"), "utf8"));
  assert.equal(playwrightPackage.version, "1.62.0");
  return {
    runnerSha256: sha256(await readFile(new URL(import.meta.url))),
    mobile: {
      evidenceClass: archive.evidenceClass,
      sourceClaim: archive.sourceClaim,
      sourceTreeSha256: archive.sourceTreeSha256,
      sourceRoots: archive.sourceRoots,
      dependencies: archive.dependencies,
      productPins: archive.productPins,
      archivedBuilderCommit: archive.archivedBuilderCommit,
      builderCommitIsNotCurrentSourceClaim: archive.builderCommitIsNotCurrentSourceClaim,
    },
    web: {
      archiveRoot: archive.archiveRelativeRoot,
      ownedRoot: relative(repoRoot, copiedMobileDist.ownedRoot),
      archiveReceiptSha256: archive.receiptSha256,
      promotionSha256: archive.promotionSha256,
      exporterManifestSha256: archive.exporterManifestSha256,
      sourceBeforeAfterSha256: archive.sourceBeforeAfterSha256,
      resourceCount: ownedDist.resourceCount,
      bundleSha256: archive.bundleSha256,
      officialManifestSha256: ownedDist.manifestSha256,
      resourceTableSha256: ownedDist.resourceTableSha256,
      sourceStableDuringCopy: copiedMobileDist.sourceStableDuringCopy,
      ownedCopyVerified: copiedMobileDist.ownedCopyVerified,
    },
    gateway: {
      root: relative(repoRoot, gatewayRuntime.root),
      freezeManifestSha256: gatewayRuntime.manifestSha256,
      sourceCount: 74,
      sourceSha256: gatewayRuntime.sourceTreeSha256,
      dependencyCount: 1034,
      dependencySha256: gatewayRuntime.dependencyTreeSha256,
      binarySha256: gatewayRuntime.binarySha256,
      nodeVersion: gatewayRuntime.nodeVersion,
      nodeSha256: EXPECTED.nodeSha256,
      mock: true,
      rustBinaryExecuted: false,
    },
    chromium: { path: chromiumPath, sha256: EXPECTED.chromiumSha256, version: EXPECTED.chromiumVersion, playwrightTestVersion: playwrightPackage.version },
    harness: {
      chromiumHelperSha256: sha256(await readFile(resolve(appRoot, "e2e/harness/chromium.mjs"))),
      gatewayHelperSha256: sha256(await readFile(resolve(appRoot, "e2e/harness/pinned-gateway.mjs"))),
      runContextSha256: sha256(await readFile(resolve(appRoot, "e2e/harness/run-context.mjs"))),
    },
  };
}

async function verifyInputs(officialInput, copiedMobileDist, sourceOptions) {
  const official = await readOfficialMobileExportReceipt(officialInput, sourceOptions);
  assert.equal(official.builderCommit, EXPECTED.mobileCommit);
  assert.equal(official.receiptSha256, OFFICIAL_EXPORT.receiptSha256);
  assert.equal(official.runManifestSha256, OFFICIAL_EXPORT.runManifestSha256);
  assert.equal(official.receipt.source.sourceTreeSha256, EXPECTED.mobileSourceDigest);
  assert.equal(official.receipt.source.mobileTree, EXPECTED.mobileGitTree);
  assert.equal(official.receipt.source.sharedTree, EXPECTED.sharedGitTree);
  assert.equal(official.manifestSha256, EXPECTED.webManifestSha256);
  assert.equal(official.receipt.officialDeployment.resourceCount, EXPECTED.webFiles);
  assert.equal(official.receipt.officialDeployment.bundleSha256, EXPECTED.webBundleSha256);
  assert.equal(official.receipt.reuseInput.manifestSha256, EXPECTED.webReuseManifestSha256);
  assert.equal(official.builderSourceProvenance.mode, "immutableSnapshot");
  const ownedDist = await inspectOfficialMobileStaticDist({
    distRoot: copiedMobileDist.ownedRoot,
    expectedManifestSha256: EXPECTED.webManifestSha256,
  });
  assert.equal(ownedDist.resourceCount, EXPECTED.webFiles);
  assert.equal(ownedDist.resourceTableSha256, official.sourceDist.resourceTableSha256);
  assert.equal(copiedMobileDist.sourceStableDuringCopy, true);
  assert.equal(copiedMobileDist.ownedCopyVerified, true);

  const gatewaySnapshotRoot = resolve(repoRoot, GATEWAY_SNAPSHOT);
  const targetTestRoot = resolve(repoRoot, "target/test");
  assert.ok(gatewaySnapshotRoot.startsWith(`${targetTestRoot}${sep}`), "Gateway snapshot must remain under the approved target/test input root");
  assert.equal(await realpath(gatewaySnapshotRoot), gatewaySnapshotRoot, "Gateway snapshot path must not traverse a symlink");
  const gatewayManifestPath = resolve(gatewaySnapshotRoot, "gateway-runtime-freeze.json");
  const gatewayManifestInfo = await lstat(gatewayManifestPath);
  assert.ok(gatewayManifestInfo.isFile() && !gatewayManifestInfo.isSymbolicLink(), "Gateway freeze manifest must be a regular file");
  const gatewayManifestBytes = await readFile(gatewayManifestPath);
  const gatewayManifest = JSON.parse(gatewayManifestBytes.toString("utf8"));
  assert.equal(sha256(gatewayManifestBytes), EXPECTED.gatewayFreezeSha256);
  assert.equal(gatewayManifest.status, "complete");
  assert.equal(gatewayManifest.sourceTreeSha256, EXPECTED.gatewaySourceSha256);
  assert.equal(gatewayManifest.dependencyTreeSha256, EXPECTED.gatewayDependencySha256);
  assert.equal(gatewayManifest.sourceFiles.length, EXPECTED.gatewaySourceFiles);
  assert.equal(gatewayManifest.dependencyFiles.length, 1034);
  assert.equal(gatewayManifest.sourceFiles.find(file => file.path === "src/mobile-web-static.js")?.sha256, EXPECTED.gatewayMobileWebStaticSha256);
  const runtime = gatewayManifest.runtimeInputs;
  assert.equal(runtime.nodeVersion, process.version);
  assert.equal(resolve(runtime.nodeExecutable), resolve(process.execPath));
  assert.equal(await realExecutableDigest(runtime.nodeExecutable), EXPECTED.nodeSha256);
  assert.equal(resolve(runtime.kcoderBinaryPath), resolve(repoRoot, "target/debug/kcoder"));
  assert.equal(runtime.kcoderBinaryStat, null, "this mock-only run must not claim or require a Rust binary");
  assert.equal(runtime.kcoderBinarySha256, null, "this mock-only run must not claim or require a Rust binary");
  const gatewayTrees = await verifyGatewayTrees(gatewaySnapshotRoot, gatewayManifest);
  assert.equal(gatewayTrees.sourceSha256, EXPECTED.gatewaySourceSha256);
  assert.equal(gatewayTrees.dependencySha256, EXPECTED.gatewayDependencySha256);
  const chromiumPath = "/opt/cft/chrome-linux64/chrome";
  assert.equal(await realExecutableDigest(chromiumPath), EXPECTED.chromiumSha256);
  const playwrightPackage = JSON.parse(await readFile(resolve(appRoot, "renderer/node_modules/@playwright/test/package.json"), "utf8"));
  assert.equal(playwrightPackage.version, "1.62.0");
  return {
    runnerSha256: sha256(await readFile(new URL(import.meta.url))),
    mobile: {
      sourceCommit: official.builderCommit,
      mobileGitTree: official.receipt.source.mobileTree,
      sharedGitTree: official.receipt.source.sharedTree,
      sourceDigest: official.receipt.source.sourceTreeSha256,
      officialSourceProvenance: official.builderSourceProvenance,
    },
    web: {
      originalRoot: relative(repoRoot, official.distRoot),
      ownedRoot: relative(repoRoot, copiedMobileDist.ownedRoot),
      resourceCount: ownedDist.resourceCount,
      bundleSha256: EXPECTED.webBundleSha256,
      officialManifestSha256: ownedDist.manifestSha256,
      resourceTableSha256: ownedDist.resourceTableSha256,
      receiptSha256: official.receiptSha256,
      runManifestSha256: official.runManifestSha256,
      reuseManifestSha256: EXPECTED.webReuseManifestSha256,
      sourceStableDuringCopy: copiedMobileDist.sourceStableDuringCopy,
      ownedCopyVerified: copiedMobileDist.ownedCopyVerified,
    },
    gateway: { root: relative(repoRoot, gatewaySnapshotRoot), freezeManifestSha256: sha256(gatewayManifestBytes), sourceCount: gatewayManifest.sourceFiles.length, sourceSha256: gatewayTrees.sourceSha256, dependencyCount: gatewayManifest.dependencyFiles.length, dependencySha256: gatewayTrees.dependencySha256, rustBinaryUsed: false, rustBinarySha256: null, nodeVersion: process.version, nodeSha256: EXPECTED.nodeSha256 },
    chromium: { path: chromiumPath, sha256: EXPECTED.chromiumSha256, version: EXPECTED.chromiumVersion, playwrightTestVersion: playwrightPackage.version },
    harness: { chromiumHelperSha256: sha256(await readFile(resolve(appRoot, "e2e/harness/chromium.mjs"))), gatewayHelperSha256: sha256(await readFile(resolve(appRoot, "e2e/harness/gateway.mjs"))), runContextSha256: sha256(await readFile(resolve(appRoot, "e2e/harness/run-context.mjs"))) },
  };
}

async function realExecutableDigest(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function verifyGatewayTrees(root, manifest) {
  const source = await verifyListedFiles(root, manifest.sourceFiles, false);
  const dependency = await verifyListedFiles(resolve(root, "node_modules"), manifest.dependencyFiles, true);
  const sourceSha256 = sha256(Buffer.from(JSON.stringify(source)));
  const dependencySha256 = sha256(Buffer.from(JSON.stringify(dependency)));
  assert.equal(sourceSha256, manifest.sourceTreeSha256, "Gateway source tree differs from its frozen manifest");
  assert.equal(dependencySha256, manifest.dependencyTreeSha256, "Gateway dependency tree differs from its frozen manifest");
  return { sourceSha256, dependencySha256 };
}

async function verifyListedFiles(root, manifestRows, allowSymlinks) {
  const actualRows = [];
  for (const row of manifestRows) {
    const path = resolve(root, row.path);
    assert.ok(path.startsWith(`${root}${sep}`), `manifest path escaped its frozen root: ${row.path}`);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      assert.equal(allowSymlinks, true, `Gateway source symlink is forbidden: ${row.path}`);
      const symlinkTarget = await readlink(path);
      assert.equal(symlinkTarget, row.symlinkTarget, `Gateway dependency symlink drift: ${row.path}`);
      actualRows.push({ path: row.path, symlinkTarget });
      const targetInfo = await stat(path);
      if (targetInfo.isDirectory()) continue;
      assert.ok(targetInfo.isFile(), `Gateway dependency symlink target is not a regular file: ${row.path}`);
      const bytes = await readFile(path);
      assert.equal(bytes.length, row.size, `Gateway symlinked dependency size drift: ${row.path}`);
      const digest = sha256(bytes);
      assert.equal(digest, row.sha256, `Gateway symlinked dependency hash drift: ${row.path}`);
      actualRows.push({ path: row.path, size: bytes.length, sha256: digest });
      continue;
    }
    assert.ok(info.isFile(), `frozen Gateway entry must be a regular file: ${row.path}`);
    const bytes = await readFile(path);
    assert.equal(bytes.length, row.size, `Gateway file size drift: ${row.path}`);
    const digest = sha256(bytes);
    assert.equal(digest, row.sha256, `Gateway file hash drift: ${row.path}`);
    actualRows.push({ path: row.path, size: bytes.length, sha256: digest });
  }
  actualRows.sort((left, right) => left.path.localeCompare(right.path));
  return actualRows;
}

async function waitUntilEpoch(deadline) {
  const remaining = deadline - Date.now();
  if (remaining > 0) await new Promise(resolveDelay => setTimeout(resolveDelay, remaining));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
