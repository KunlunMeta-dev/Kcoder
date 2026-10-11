import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../harness/run-context.mjs";
import { resolveExistingPrivateGatewaySnapshot } from "../suites/mobile/helpers/gateway-runtime-snapshot-guard.mjs";

const MOBILE_ADAPTER = resolve(repoRoot, "target/private-phone-ux-validation/p1a-home-readiness-339-adapter-20261009");
const ADAPTER_RECEIPT = resolve(repoRoot, "target/private-phone-ux-validation/p1a-home-readiness-339-adapter-receipt.json");
const WEB_ROOT = resolve(repoRoot, "target/private-phone-ux-implementation/mobile-web-export-default-catalog-parallel-20261009-090018");
const WEB_MANIFEST = `${WEB_ROOT}-manifest.json`;
const GATEWAY_SNAPSHOT = "target/private-phone-ux-implementation/render-profile-gateway-runtime-c22-20261009";
const GATEWAY_BINARY = resolve(repoRoot, "target/private-phone-ux-validation/b2-static03-build-20261008/frozen-candidate/kcoder");
const onlyStatus401 = process.argv.includes("--only-status-401");
const EXPECTED = {
  mobileFiles: 339,
  mobileSourceDigest: "649a35cd63b42a43bb2cba9e74fdc2ba9e1586090f56507a0f4dd3cc4ad6667f",
  mobileMapSha256: "d3f7b230cd925035f3905fb67c8050964fc38bc6b5cf50965da5a52776e19ef8",
  mobileMetadataSha256: "eea7e49fa96cb37ba1f2e656855fc080c9ef15c41f312652c92007c2293f7713",
  mobileSourceManifestSha256: "2973c553c2d40f010f7c73cb1656079cbc11634ed67e8d983a1116ce15b10c42",
  webFiles: 37,
  webBundleSha256: "1d00952cd276c22b1c37371e39e8719adcdee46ca724246d768d287e2479d9c7",
  webManifestSha256: "af1066420b8fc817d7aeb7b713658ea8a4cfea284ad49092ff7549f41a2c7518",
  gatewaySourceSha256: "02f803a6da08b5e6ee0915ed35da295b2cfd84548ff8c09d3ba67016233f0e24",
  gatewayDependencySha256: "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954",
  gatewayFreezeSha256: "474ea99288424030dddcba6a63f47689e8dd7f24c18ca5a9e21bb78c6262c39b",
  gatewayBinarySha256: "289618f7e0670be9840b48adcd93d73261ea1c20034596ae6a95d5ed41f3b67d",
  nodeSha256: "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9",
  chromiumSha256: "0b20b130e7edd9dd51873be867761295fe0cfad490c2b9a64f95bd3cfc08fa71",
  chromiumVersion: "151.0.7922.34",
};

await runE2E(import.meta.url, {
  testId: "mobile-home-readiness-frozen-339",
  tier: "manual-live",
  modelPolicy: "mounted Mobile Web readiness checks in isolated KCODER_STUDIO_MOCK Gateway; no model Provider or production service",
  retainSuccessLogs: true,
}, async context => {
  const inputsBefore = await verifyInputs(context);
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
  const gateway = await startGateway(context, {
    label: "p1a-mock-gateway",
    gatewayRoot: resolve(repoRoot, GATEWAY_SNAPSHOT),
    cwd: resolve(repoRoot, GATEWAY_SNAPSHOT),
    workspace,
    serversFile,
    serversStore,
    kcoderBin: GATEWAY_BINARY,
    auth: true,
    env: {
      KCODER_STUDIO_WEB_ROOT: WEB_ROOT,
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

  const inputsAfter = await verifyInputs(context);
  assert.deepEqual(inputsAfter, inputsBefore, "frozen Mobile, export, Gateway, and executable inputs changed during the run");
  await context.writeArtifactJson("p1a-home-readiness-summary.json", {
    schemaVersion: 1,
    result: rows.every(row => row.status === "PASS") ? "PASS" : "FAIL",
    runScope: onlyStatus401 ? "single status-401 authorization-refresh recovery scenario; other P1-A scenarios retain separate prior run evidence" : "three mounted Home readiness scenarios",
    evidenceBoundary: "local Chromium mobile viewport + isolated mock Gateway; frozen Mobile source, not native-device or public-Relay evidence",
    scenarios: rows,
    inputsBefore,
    inputsAfter,
    browser: {
      version: await chromium.browser.version(),
      executablePath: chromium.executablePath,
      viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    },
    gateway: { pid: gateway.child.pid, port: gateway.port, mock: true },
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
  const responseEvents = captureRelevantResponses(page);
  try {
    await connectHome(page, gateway);
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
  const responses = captureRelevantResponses(page);
  const successfulStatus = page.waitForResponse(response => new URL(response.url()).pathname === "/api/servers/status" && response.status() === 200, { timeout: 15_000 });
  void successfulStatus.catch(() => {});
  let failureInjectionActive = false;
  let remainingFailureResponses = statusCode === 401 ? Number.POSITIVE_INFINITY : 1;
  await page.route("**/api/servers/status", async route => {
    if (failureInjectionActive && remainingFailureResponses > 0) {
      if (statusCode !== 401) remainingFailureResponses -= 1;
      await route.fulfill({
        status: statusCode,
        contentType: "application/json",
        body: JSON.stringify({ error: statusCode === 401 ? "reauthorization-required" : "status-unavailable" }),
      });
      return;
    }
    await route.continue();
  });
  try {
    await connectHome(page, gateway);
    await successfulStatus;
    failureInjectionActive = true;
    const injectedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/servers/status" && response.status() === statusCode, { timeout: 15_000 });
    void injectedResponse.catch(() => {});
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await injectedResponse;
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
    }
    const statusResponses = responses.filter(item => item.pathname === "/api/servers/status");
    const refreshResponses = responses.filter(item => item.pathname === "/api/mobile/session/refresh");
    assert.ok(statusResponses.some(item => item.status === 200), "a successful status response must precede the injected failure");
    assert.ok(statusResponses.some(item => item.status === statusCode), `expected exact injected HTTP ${statusCode}`);
    return {
      scenario: statusCode === 503 ? "status-503-local-error" : "status-401-reauthorization",
      status: "PASS",
      successfulStatusBeforeFailure: true,
      injectedStatus: statusCode,
      serverVisible,
      threadVisible,
      newVisible,
      statusErrorVisible: statusCode === 503,
      reauthorizationVisible: statusCode === 401,
      statusResponses,
      refreshResponses,
    };
  } catch (error) {
    return {
      scenario: statusCode === 503 ? "status-503-local-error" : "status-401-reauthorization",
      status: "FAIL",
      errorName: error?.name || "Error",
      error: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 800),
      initialStatus200Observed: responses.some(item => item.pathname === "/api/servers/status" && item.status === 200),
      injectedStatusObserved: responses.some(item => item.pathname === "/api/servers/status" && item.status === statusCode),
      statusResponses: responses.filter(item => item.pathname === "/api/servers/status"),
      refreshResponses: responses.filter(item => item.pathname === "/api/mobile/session/refresh"),
    };
  } finally {
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}

async function connectHome(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, "isolated Gateway should serve the Mobile Web entry");
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await page.locator('button[type="submit"]').click();
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await ensureThreadVisible(page);
}

async function ensureThreadVisible(page) {
  const thread = page.getByTestId("thread-mock-active-session");
  if (await thread.isVisible().catch(() => false)) return;
  const server = page.getByTestId("toggle-server-backend4a");
  await server.waitFor({ state: "visible", timeout: 20_000 });
  if ((await server.getAttribute("aria-expanded")) !== "true") await server.click();
  await thread.waitFor({ state: "visible", timeout: 20_000 });
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

function captureRelevantResponses(page) {
  const rows = [];
  page.on("response", response => {
    try {
      const url = new URL(response.url());
      if (["/api/servers/status", "/api/mobile/session/refresh"].includes(url.pathname)) {
        rows.push({ ordinal: rows.length + 1, method: response.request().method(), pathname: url.pathname, status: response.status(), atEpochMs: Date.now() });
      }
    } catch { /* ignore non-URL response objects */ }
  });
  return rows;
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

async function verifyInputs(context) {
  const metadata = JSON.parse(await readFile(resolve(MOBILE_ADAPTER, "metadata.json"), "utf8"));
  const shaMapBytes = await readFile(resolve(MOBILE_ADAPTER, "sha256.json"));
  const sourceManifestBytes = await readFile(resolve(MOBILE_ADAPTER, "source-manifest.json"));
  const adapterReceiptBytes = await readFile(ADAPTER_RECEIPT);
  assert.equal(sha256(sourceManifestBytes), EXPECTED.mobileSourceManifestSha256);
  assert.equal(sha256(adapterReceiptBytes), "6db42b7611e44c7d88c6be3562adac37fba22acd83509079b9c03cdb52442ba2");
  const map = JSON.parse(shaMapBytes.toString("utf8"));
  assert.equal(metadata.sourceFiles, EXPECTED.mobileFiles);
  assert.equal(metadata.sourceDigest, EXPECTED.mobileSourceDigest);
  assert.equal(sha256(shaMapBytes), EXPECTED.mobileMapSha256);
  assert.equal(sha256(await readFile(resolve(MOBILE_ADAPTER, "metadata.json"))), EXPECTED.mobileMetadataSha256);
  assert.equal(Object.keys(map).length, EXPECTED.mobileFiles);
  assert.equal(map["apps/kcoder-studio/mobile/package-lock.json"], "848076f520f165128b601b27d96d4d32cf25e8929ee54b672f198b9a4c224e26");
  const sourceRows = [];
  for (const [path, expected] of Object.entries(map)) {
    const file = resolve(MOBILE_ADAPTER, path);
    assert.ok(file.startsWith(`${MOBILE_ADAPTER}${sep}`));
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `frozen Mobile input must be a regular file: ${path}`);
    const bytes = await readFile(file);
    const digest = sha256(bytes);
    assert.equal(digest, expected, `Mobile adapter drift: ${path}`);
    sourceRows.push({ path, size: bytes.length, sha256: digest });
  }
  const exportManifestBytes = await readFile(WEB_MANIFEST);
  assert.equal(sha256(exportManifestBytes), EXPECTED.webManifestSha256);
  const exportManifest = JSON.parse(exportManifestBytes.toString("utf8"));
  assert.equal(exportManifest.status, "complete");
  assert.equal(exportManifest.sourceTreeSha256, EXPECTED.mobileSourceDigest);
  assert.equal(exportManifest.bundleFileCount, EXPECTED.webFiles);
  assert.equal(exportManifest.bundleSha256, EXPECTED.webBundleSha256);
  for (const item of exportManifest.bundleFiles) {
    const file = resolve(WEB_ROOT, item.path);
    assert.ok(file.startsWith(`${WEB_ROOT}${sep}`));
    const bytes = await readFile(file);
    assert.equal(bytes.length, item.size, `export bundle size drift: ${item.path}`);
    assert.equal(sha256(bytes), item.sha256, `export bundle hash drift: ${item.path}`);
  }
  const gateway = await resolveExistingPrivateGatewaySnapshot(repoRoot, GATEWAY_SNAPSHOT);
  assert.equal(sha256(await readFile(gateway.manifestPath)), EXPECTED.gatewayFreezeSha256);
  assert.equal(gateway.manifest.sourceTreeSha256, EXPECTED.gatewaySourceSha256);
  assert.equal(gateway.manifest.dependencyTreeSha256, EXPECTED.gatewayDependencySha256);
  assert.equal(gateway.manifest.sourceFiles.length, 67);
  assert.equal(gateway.manifest.dependencyFiles.length, 1034);
  const runtime = gateway.manifest.runtimeInputs;
  assert.equal(runtime.nodeVersion, process.version);
  assert.equal(resolve(runtime.nodeExecutable), resolve(process.execPath));
  assert.equal(await realExecutableDigest(runtime.nodeExecutable), EXPECTED.nodeSha256);
  const binaryHash = await realExecutableDigest(GATEWAY_BINARY);
  assert.equal(binaryHash, EXPECTED.gatewayBinarySha256);
  const gatewayTrees = await verifyGatewayTrees(gateway.snapshotRoot, gateway.manifest);
  assert.equal(gatewayTrees.sourceSha256, EXPECTED.gatewaySourceSha256);
  assert.equal(gatewayTrees.dependencySha256, EXPECTED.gatewayDependencySha256);
  const chromiumPath = "/opt/cft/chrome-linux64/chrome";
  assert.equal(await realExecutableDigest(chromiumPath), EXPECTED.chromiumSha256);
  const playwrightPackage = JSON.parse(await readFile(resolve(appRoot, "renderer/node_modules/@playwright/test/package.json"), "utf8"));
  assert.equal(playwrightPackage.version, "1.62.0");
  return {
    runnerSha256: sha256(await readFile(new URL(import.meta.url))),
    mobile: { adapter: relative(repoRoot, MOBILE_ADAPTER), adapterReceiptSha256: sha256(adapterReceiptBytes), count: sourceRows.length, sourceDigest: metadata.sourceDigest, mapSha256: sha256(shaMapBytes), metadataSha256: sha256(await readFile(resolve(MOBILE_ADAPTER, "metadata.json"))), sourceManifestSha256: sha256(sourceManifestBytes) },
    web: { root: relative(repoRoot, WEB_ROOT), fileCount: exportManifest.bundleFileCount, bundleSha256: exportManifest.bundleSha256, manifestSha256: sha256(exportManifestBytes) },
    gateway: { root: relative(repoRoot, gateway.snapshotRoot), freezeManifestSha256: sha256(await readFile(gateway.manifestPath)), sourceCount: gateway.manifest.sourceFiles.length, sourceSha256: gatewayTrees.sourceSha256, dependencyCount: gateway.manifest.dependencyFiles.length, dependencySha256: gatewayTrees.dependencySha256, binarySha256: binaryHash, nodeVersion: process.version, nodeSha256: EXPECTED.nodeSha256 },
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
