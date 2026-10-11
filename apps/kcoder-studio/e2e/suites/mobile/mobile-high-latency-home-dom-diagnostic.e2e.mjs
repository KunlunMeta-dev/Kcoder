import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { startChromium } from "../../harness/chromium.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { startPinnedSnapshotGateway, validatePinnedGatewayRuntime } from "../../harness/pinned-gateway.mjs";
import { resolveExistingPrivatePath } from "../../harness/gateway-runtime-snapshot-guard.mjs";

const SMOKE_ONLY = process.argv.includes("--smoke-only");
assert.equal(SMOKE_ONLY, true, "run this one-pair diagnostic only with --smoke-only");

const DELAY_MS = 600;
const MIN_APPLIED_DELAY_MS = DELAY_MS - 5;
const SAMPLES_PER_BUNDLE = 1;
const SERVER_ID = "backend4a";
const THREAD_ID = "mock-active-session";
const PENDING_HTTP_TUPLE_ALLOWLIST = Object.freeze([
  "GET /api/servers",
  "GET /api/servers/status",
]);
const PAGE_CONTEXT = Object.freeze({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: "zh-CN",
});
const EXPECTED_NODE_VERSION = "v22.17.0";
const EXPECTED_CHROMIUM_VERSION = "151.0.7922.34";
const B50_SOURCE = Object.freeze({
  path: "apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-ux.e2e.mjs",
  sha256: "b50e0d3512fcae1665625316f2639835fdb2f9246fc1c38109f26cad276da4e0",
});
const PLAYWRIGHT_CORE = Object.freeze({
  packagePath: "apps/kcoder-studio/renderer/node_modules/.pnpm/playwright-core@1.62.0/node_modules/playwright-core/package.json",
  sourcePath: "apps/kcoder-studio/renderer/node_modules/.pnpm/playwright-core@1.62.0/node_modules/playwright-core/lib/coreBundle.js",
  version: "1.62.0",
  sourceSha256: "3258d1cf334c6afc95f22aa9c292436cb976b391e0437f1359c83b84f0cb9d66",
});
const MAX_NETWORK_EVENTS = 512;
const E2E_ARTIFACT_ROOT = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e");

const BUNDLE_INPUTS = Object.freeze([
  {
    snapshot: "before",
    bundleRelativePath: "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-ux.e2e.mjs/20261008-030423.281Z/artifacts/mobile-web-export",
    manifestRelativePath: "target/private-phone-ux-implementation/before-render-export-pinned/mobile-web-export-mobile-high-latency-before-manifest.json",
    expectedManifestSha256: "e2f0771adfc3fb00261a9ab277686dc24c2b44b402f0b459811fa58cfbcea261",
    expectedSourceTreeSha256: "c2dd305c2b3dffd30285e3e4ce934b7480df4cfdf9bd3cb227d2c170d3ec2166",
    expectedBundleSha256: "44e7916aa3cf104b5f9b95666b50f2c44b74a776cc3a55f817c204011ec63b64",
    expectedIndexHtmlSha256: "0fd65e20f4fae5e093baa69020e4a21bc46737faae25ac4804789a065adcde7f",
  },
  {
    snapshot: "after",
    bundleRelativePath: "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-ux.e2e.mjs/20261008-044749.324Z/artifacts/mobile-web-export",
    manifestRelativePath: "target/private-phone-ux-implementation/mobile-web-export-final-ux-20261008-manifest.json",
    expectedManifestSha256: "8588dec1c6a14d13aef01f69e5feaee9e152439652191ad790397c471cad71ae",
    expectedSourceTreeSha256: "068c00e3621b911a3fec8a0f97500db5f816e7b09203217e49e363323ec1c93a",
    expectedBundleSha256: "1cffdbe539cc8dcef3c411e3daf85e20283de280d9c37a2bf460616125f70f00",
    expectedIndexHtmlSha256: "b059b59d69fdd5d412051708f7ed6aea293dedfa7bdd429e3b3659bf08ce5ddd",
  },
]);

const GATEWAY_PIN = Object.freeze({
  snapshotRelativePath: "target/private-phone-ux-implementation/nav-gateway-runtime-restored",
  expectedManifestSha256: "f026430f4b28b9da31f33140ec5892bcf19f54ada97f77744ed6f0144a6b06eb",
  expectedSourceTreeSha256: "d16bfd1ebb61e516e418e67d0a982860e6980fca4fa9df900fefcb71db9fa135",
  expectedDependencyTreeSha256: "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954",
  expectedDevServerSha256: "1bc457ed898192692deb5e884e0f087e2fe6b406e3217db8e41e4f41baf547b3",
  expectedBinaryPath: "target/packages/kcoder-studio-gateway/20261007T110812Z-641626d-dirty/kcoder",
  expectedBinarySha256: "d1c98e33084e6dc8692d0e710d22affb01ebfd79a8d60a4b37965a6d841cbcf6",
  expectedNodeVersion: EXPECTED_NODE_VERSION,
});

await runE2E(import.meta.url, {
  testId: "mobile-high-latency-home-dom-causal-diagnostic",
  tier: "manual-live",
  modelPolicy: "one isolated mock-Gateway home-load sample per pinned Mobile Web bundle; no Provider, user Gateway, production session, or task-entry interaction",
  retainSuccessLogs: true,
}, async context => {
  const inputs = [];
  const rows = [];
  const b50Source = await verifyPinnedSource(B50_SOURCE.path, B50_SOURCE.sha256);
  const playwrightSource = await verifyPlaywrightCorePin();
  const gatewayRuntime = await validatePinnedGatewayRuntime(GATEWAY_PIN);
  for (const input of BUNDLE_INPUTS) inputs.push(await verifyPinnedBundle(input));
  await context.writeArtifactJson("diagnostic-input-pins.json", {
    scope: "SMOKE_ONLY paired n=1; before and after bundles reused as exported; no Expo build and no b50 modification",
    delayMs: DELAY_MS,
    samplesPerBundle: SAMPLES_PER_BUNDLE,
    viewport: PAGE_CONTEXT,
    originalB50Source: b50Source,
    nodeVersion: process.version,
    gatewayRuntime: {
      snapshotPath: repoRelative(gatewayRuntime.root),
      manifestPath: repoRelative(gatewayRuntime.manifestPath),
      manifestSha256: gatewayRuntime.manifestSha256,
      sourceTreeSha256: gatewayRuntime.sourceTreeSha256,
      dependencyTreeSha256: gatewayRuntime.dependencyTreeSha256,
      nodeExecutable: gatewayRuntime.nodeExecutable,
      nodeVersion: gatewayRuntime.nodeVersion,
      binaryPath: repoRelative(gatewayRuntime.binaryPath),
      binarySha256: gatewayRuntime.binarySha256,
      devServerPath: repoRelative(gatewayRuntime.scriptPath),
      devServerSha256: gatewayRuntime.scriptSha256,
    },
    bundles: inputs.map(summarizeBundle),
    timingBoundary: "Node monotonic and epoch boundaries cover goto, new-workspace wait, and ensureFixtureSessionVisible; document-start MutationObserver+RAF records first Playwright-equivalent visible frames on the same epoch timebase",
    networkBoundary: "only measured page events, each tagged with its own pageId and cold-runtime-warm-profile-home-{before|after} stage; no task-entry stage or payloads are recorded",
    requiredHomeResponses: ["GET /api/servers", "RPC initialize response", "RPC thread/list response"],
    requiredMinimumAppliedDelayMs: MIN_APPLIED_DELAY_MS,
    pendingHttpTupleAllowlist: PENDING_HTTP_TUPLE_ALLOWLIST,
    visibilityImplementation: {
      playwrightVersion: playwrightSource.version,
      source: playwrightSource.source,
      sourceSha256: playwrightSource.sourceSha256,
      semantics: "computeBox/isElementVisible: checkVisibility with details fallback, visibility CSS, display:contents child handling, and positive bounding-box dimensions",
      waitForPolling: {
        function: "retryWithProgressAndBackoff",
        intervalsMs: [20, 50, 100, 100, 500],
        interpretation: "source pin only; the paired sample measures any wait-return overshoot and does not assume this caused it",
      },
    },
    statusLimit: "diagnostic only: n=1 per bundle; does not establish a population regression or prove Playwright polling caused a delay",
  });

  const chromium = await startChromium(context, {
    label: "home-dom-diagnostic-chromium",
    noSandbox: true,
  });
  const chromiumVersion = chromium.browser.version();
  assert.equal(chromiumVersion, EXPECTED_CHROMIUM_VERSION, "diagnostic Chromium differs from the matched b50 browser version");

  let nextPageId = 0;
  try {
    for (const input of inputs) {
      const row = await runPinnedHomeSample(context, chromium, gatewayRuntime, input, ++nextPageId);
      rows.push(row);
      await context.writeArtifactJson(`home-dom-${input.snapshot}.json`, row);
    }
    const result = {
      schemaVersion: 1,
      status: rows.every(row => row.status === "DIAGNOSTIC_COMPLETE")
        ? "DIAGNOSTIC_COMPLETE"
        : "INCOMPLETE",
      smokeOnly: true,
      samplesPerBundle: SAMPLES_PER_BUNDLE,
      configuredResponseDelayMs: DELAY_MS,
      chromiumVersion,
      rows,
      interpretation: "Compare browser first-visible RAF epochs with each Node wait return in their common epoch timebase. This n=1 pair can expose a poll-boundary amplification pattern but cannot prove a stable performance regression or causality.",
      cleanupBoundary: "every page is closed after its home-only capture; each mock Gateway is stopped by its RunContext-owned process label; Chromium is closed by RunContext cleanup",
    };
    await context.writeArtifactJson("paired-home-dom-diagnostic.json", result);
    return result;
  } catch (error) {
    await context.writeArtifactJson("paired-home-dom-diagnostic-partial.json", {
      status: "FAILED_OR_INCOMPLETE",
      samplesPerBundle: SAMPLES_PER_BUNDLE,
      configuredResponseDelayMs: DELAY_MS,
      chromiumVersion,
      completedRows: rows,
      errorName: error?.name || "Error",
      errorMessage: context.redactText(error instanceof Error ? error.message : String(error)).slice(0, 1000),
    }).catch(() => undefined);
    throw error;
  }
});

async function verifyPinnedBundle(pin) {
  const manifestPath = await resolveExistingPrivatePath(repoRoot, pin.manifestRelativePath);
  const manifestInfo = await lstat(manifestPath);
  assert.ok(manifestInfo.isFile() && !manifestInfo.isSymbolicLink(), `${pin.snapshot} Mobile Web pin must be a regular file`);
  const manifestBytes = await readFile(manifestPath);
  assert.equal(sha256(manifestBytes), pin.expectedManifestSha256, `${pin.snapshot} Mobile Web pin manifest changed`);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.status, "complete", `${pin.snapshot} Mobile Web export is incomplete`);
  assert.equal(manifest.sourceUnchanged, true, `${pin.snapshot} Mobile Web source changed during export`);
  assert.equal(manifest.snapshotUnchangedDuringExport, true, `${pin.snapshot} Mobile Web build snapshot changed during export`);
  assert.equal(manifest.sourceTreeSha256, pin.expectedSourceTreeSha256, `${pin.snapshot} Mobile Web source tree digest changed`);
  assert.equal(manifest.bundleSha256, pin.expectedBundleSha256, `${pin.snapshot} Mobile Web bundle digest changed`);
  assert.equal(manifest.indexHtmlSha256, pin.expectedIndexHtmlSha256, `${pin.snapshot} index.html digest changed`);
  assert.equal(manifest.bundleFileCount, 37, `${pin.snapshot} Mobile Web bundle count changed`);
  assert.ok(Array.isArray(manifest.bundleFiles) && manifest.bundleFiles.length === 37, `${pin.snapshot} source manifest must list exactly 37 bundle files`);

  const files = manifest.bundleFiles.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }));
  assert.equal(sha256(Buffer.from(JSON.stringify(files))), pin.expectedBundleSha256, `${pin.snapshot} ordered bundle file table differs from its bundle digest`);
  const bundleRoot = resolve(repoRoot, pin.bundleRelativePath);
  assert.ok(isWithin(E2E_ARTIFACT_ROOT, bundleRoot), `${pin.snapshot} bundle must remain within the retained E2E artifact boundary`);
  assert.equal(await realpath(bundleRoot), bundleRoot, `${pin.snapshot} bundle path must not traverse a symlink`);
  const bundleInfo = await lstat(bundleRoot);
  assert.ok(bundleInfo.isDirectory() && !bundleInfo.isSymbolicLink(), `${pin.snapshot} bundle root must be a regular directory`);

  const listed = new Set();
  for (const file of files) {
    assertSafeBundlePath(file.path);
    assert.ok(!listed.has(file.path), `${pin.snapshot} bundle manifest contains a duplicate path`);
    listed.add(file.path);
    const absolute = resolve(bundleRoot, ...file.path.split("/"));
    assert.ok(isWithin(bundleRoot, absolute), `${pin.snapshot} bundle path escaped its pinned root`);
    const info = await lstat(absolute);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `${pin.snapshot} bundle entry must be a regular file: ${file.path}`);
    const bytes = await readFile(absolute);
    assert.equal(bytes.length, file.size, `${pin.snapshot} bundle file size changed: ${file.path}`);
    assert.equal(sha256(bytes), file.sha256, `${pin.snapshot} bundle file content changed: ${file.path}`);
  }
  const actualFiles = await listBundleFiles(bundleRoot);
  assert.deepEqual(actualFiles, [...listed].sort(), `${pin.snapshot} bundle contains an unlisted or missing file`);
  return {
    snapshot: pin.snapshot,
    manifestPath,
    manifestSha256: pin.expectedManifestSha256,
    sourceTreeSha256: pin.expectedSourceTreeSha256,
    bundleRoot,
    bundleSha256: pin.expectedBundleSha256,
    indexHtmlSha256: pin.expectedIndexHtmlSha256,
    bundleFileCount: files.length,
    files,
  };
}

async function verifyPinnedSource(path, expectedSha256) {
  const absolute = resolve(repoRoot, path);
  const info = await lstat(absolute);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "original b50 source must be a regular file");
  const digest = sha256(await readFile(absolute));
  assert.equal(digest, expectedSha256, "original b50 source changed from its official measurement pin");
  return { path, sha256: digest };
}

async function verifyPlaywrightCorePin() {
  const packagePath = resolve(repoRoot, PLAYWRIGHT_CORE.packagePath);
  const sourcePath = resolve(repoRoot, PLAYWRIGHT_CORE.sourcePath);
  const packageInfo = await lstat(packagePath);
  const sourceInfo = await lstat(sourcePath);
  assert.ok(packageInfo.isFile() && !packageInfo.isSymbolicLink(), "Playwright core package manifest must be a regular file");
  assert.ok(sourceInfo.isFile() && !sourceInfo.isSymbolicLink(), "Playwright core source bundle must be a regular file");
  const packageJson = JSON.parse((await readFile(packagePath)).toString("utf8"));
  assert.equal(packageJson.version, PLAYWRIGHT_CORE.version, "Playwright core version differs from the visibility implementation pin");
  const sourceSha256 = sha256(await readFile(sourcePath));
  assert.equal(sourceSha256, PLAYWRIGHT_CORE.sourceSha256, "Playwright core visibility implementation changed");
  return { version: packageJson.version, source: PLAYWRIGHT_CORE.sourcePath, sourceSha256 };
}

async function runPinnedHomeSample(context, chromium, gatewayRuntime, input, pageId) {
  const workspace = context.pathInState(`workspace-${input.snapshot}`);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const serversFile = await context.writeStateJson(`${input.snapshot}-mock-servers.json`, [{
    id: SERVER_ID,
    label: "Home DOM diagnostic fixture",
    runtime: "kcoder",
    transport: "local",
    command: process.execPath,
    workspace,
  }]);
  const serversStore = context.pathInState(`${input.snapshot}-gateway-servers-store.json`);
  const gatewayLabel = `home-dom-${input.snapshot}-mock-gateway`;
  const gateway = await startPinnedSnapshotGateway(context, gatewayRuntime, {
    label: gatewayLabel,
    workspace,
    serversFile,
    serversStore,
    webRoot: input.bundleRoot,
  });
  let setupPage;
  let measuredPage;
  try {
    setupPage = await chromium.newPage(PAGE_CONTEXT);
    const storageState = await connectWarmProfile(setupPage, gateway);
    await setupPage.close();
    setupPage = undefined;

    measuredPage = await chromium.newPage({ ...PAGE_CONTEXT, storageState });
    await measuredPage.addInitScript(installDocumentStartHomeObserver);
    const stage = `cold-runtime-warm-profile-home-${input.snapshot}`;
    const network = await installDelayedNetworkEvidence(measuredPage, { pageId, stage, delayMs: DELAY_MS });
    const nodeBoundaries = {};
    const navigationStart = nodeMark();
    const navigationResponse = await measuredPage.goto(gateway.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const navigationReturn = nodeMark();
    nodeBoundaries.goto = { started: navigationStart, returned: navigationReturn, status: navigationResponse?.status() ?? null };
    assert.equal(navigationResponse?.status(), 200, `${input.snapshot} warm-profile cold runtime did not load its pinned Gateway`);

    const newWorkspaceWaitStarted = nodeMark();
    await measuredPage.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 60_000 });
    const newWorkspaceWaitReturned = nodeMark();
    nodeBoundaries.newWorkspaceWait = { started: newWorkspaceWaitStarted, returned: newWorkspaceWaitReturned };

    const fixtureSession = await ensureFixtureSessionVisible(measuredPage);
    nodeBoundaries.ensureFixtureSessionVisible = {
      ...fixtureSession.boundaries,
      revealedByServerToggle: fixtureSession.revealedByServerToggle,
    };
    const homeReady = nodeMark();
    nodeBoundaries.homeReady = homeReady;
    network.stopCapture();
    const observerState = await measuredPage.evaluate(() => window.__mobileHomeDomDiagnostic?.snapshot() ?? null);
    assert.ok(observerState, `${input.snapshot} document-start DOM observer was not installed`);
    assert.ok(observerState.targets.newWorkspace.firstVisible, `${input.snapshot} observer missed new-workspace visibility`);
    assert.ok(observerState.targets.fixtureThread.firstVisible, `${input.snapshot} observer missed fixture-thread visibility`);

    const pageProfile = await measuredPage.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      timeOriginEpochMs: window.performance.timeOrigin,
    }));
    assert.deepEqual(
      { innerWidth: pageProfile.innerWidth, innerHeight: pageProfile.innerHeight, devicePixelRatio: pageProfile.devicePixelRatio },
      { innerWidth: 390, innerHeight: 844, devicePixelRatio: 3 },
      `${input.snapshot} mobile viewport differs from the pinned profile`,
    );

    const networkEvidence = network.snapshot();
    const networkValidation = validateHomeNetworkEvidence(networkEvidence, { pageId, stage });
    return {
      status: networkValidation.status,
      snapshot: input.snapshot,
      cacheClass: "cold-runtime-warm-profile",
      sample: 1,
      samplesPerBundle: SAMPLES_PER_BUNDLE,
      delayMs: DELAY_MS,
      pageId,
      stage,
      appState: "home only; no task route, prompt, turn, or provider request",
      input: summarizeBundle(input),
      gateway: {
        label: gatewayLabel,
        pid: gateway.pid,
        port: gateway.port,
        cwd: gateway.cwd,
        scriptPath: gateway.scriptPath,
        binaryPath: gateway.binaryPath,
        binarySha256: gateway.binarySha256,
        manifestSha256: gateway.gatewayManifestSha256,
        mock: gateway.mock,
      },
      browser: {
        version: chromium.browser.version(),
        executablePath: chromium.executablePath,
        viewport: PAGE_CONTEXT,
        pageProfile,
        warmProfileOriginCount: storageState.origins.length,
      },
      timing: {
        nodeMonotonicDurationMs: round(homeReady.monotonicMs - navigationStart.monotonicMs),
        nodeEpochStartMs: navigationStart.epochMs,
        nodeEpochHomeReadyMs: homeReady.epochMs,
        nodeBoundaries,
        browserObserver: observerState,
        visibleToNodeReturnMs: {
          newWorkspace: round(newWorkspaceWaitReturned.epochMs - observerState.targets.newWorkspace.firstVisible.epochMs),
          fixtureThread: round(homeReady.epochMs - observerState.targets.fixtureThread.firstVisible.epochMs),
          serverToggle: observerState.targets.fixtureServerToggle.firstVisible
            ? round((fixtureSession.boundaries.serverToggleWait?.returned.epochMs ?? homeReady.epochMs) - observerState.targets.fixtureServerToggle.firstVisible.epochMs)
            : null,
        },
        crossClockNote: "browser performance.timeOrigin+RAF timestamp and Node Date.now use the host epoch clock; Node monotonic deltas are retained separately",
      },
      network: networkEvidence,
      networkValidation,
      evidenceLimit: "one n=1 observation; pageId and stage are unique to this measured page; network capture stops at homeReady before any later page interaction",
    };
  } finally {
    await measuredPage?.close().catch(() => undefined);
    await setupPage?.close().catch(() => undefined);
    await context.stopOwned(gatewayLabel);
  }
}

async function connectWarmProfile(page, gateway) {
  const loginResponse = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(loginResponse?.status(), 200, "isolated Gateway login page did not load");
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
  await ensureFixtureSessionVisible(page);
  const storageState = await page.context().storageState();
  assert.ok(storageState.origins.length > 0, "profile setup did not create warm origin storage");
  return storageState;
}

async function ensureFixtureSessionVisible(page) {
  const boundaries = {};
  const thread = page.getByTestId(`thread-${THREAD_ID}`);
  let started = nodeMark();
  let visible = await thread.isVisible().catch(() => false);
  let returned = nodeMark();
  boundaries.initialThreadIsVisible = { started, returned, visible };
  if (visible) return { boundaries, revealedByServerToggle: false };

  const serverToggle = page.getByTestId(`toggle-server-${SERVER_ID}`);
  started = nodeMark();
  await serverToggle.waitFor({ state: "visible", timeout: 30_000 });
  returned = nodeMark();
  boundaries.serverToggleWait = { started, returned };
  started = nodeMark();
  const expandedBeforeClick = await serverToggle.getAttribute("aria-expanded");
  returned = nodeMark();
  boundaries.serverToggleExpandedRead = { started, returned, value: expandedBeforeClick };
  if (expandedBeforeClick !== "true") {
    started = nodeMark();
    await serverToggle.click();
    returned = nodeMark();
    boundaries.serverToggleClick = { started, returned };
  }
  started = nodeMark();
  await thread.waitFor({ state: "visible", timeout: 30_000 });
  returned = nodeMark();
  boundaries.fixtureThreadWait = { started, returned };
  return { boundaries, revealedByServerToggle: true };
}

function installDocumentStartHomeObserver() {
  const selectors = {
    newWorkspace: '[data-testid="new-workspace"]',
    fixtureServerToggle: '[data-testid="toggle-server-backend4a"]',
    fixtureThread: '[data-testid="thread-mock-active-session"]',
  };
  const targets = Object.fromEntries(Object.keys(selectors).map(name => [name, {
    firstFound: null,
    firstVisible: null,
  }]));
  let rafPending = false;
  let mutationBatches = 0;
  let scans = 0;

  const epoch = () => ({
    performanceNowMs: Number(performance.now().toFixed(3)),
    epochMs: Number((performance.timeOrigin + performance.now()).toFixed(3)),
  });

  const visibleTextNode = node => {
    const range = node.ownerDocument.createRange();
    range.selectNode(node);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const isPlaywrightVisible = element => {
    const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
    if (!style) return true;
    if (style.display === "contents") {
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && isPlaywrightVisible(child)) return true;
        if (child.nodeType === 3 && visibleTextNode(child)) return true;
      }
      return false;
    }
    if (Element.prototype.checkVisibility) {
      if (!element.checkVisibility()) return false;
    } else {
      const detailsOrSummary = element.closest("details,summary");
      if (detailsOrSummary !== element && detailsOrSummary?.nodeName === "DETAILS" && !detailsOrSummary.open) return false;
    }
    if (style.visibility !== "visible") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const scanAtAnimationFrame = () => {
    scans += 1;
    for (const [name, selector] of Object.entries(selectors)) {
      if (targets[name].firstVisible) continue;
      const element = document.querySelector(selector);
      if (!element) continue;
      targets[name].firstFound ??= epoch();
      if (isPlaywrightVisible(element)) {
        targets[name].firstVisible = epoch();
      }
    }
    if (!targets.newWorkspace.firstVisible || !targets.fixtureThread.firstVisible) scheduleAnimationFrame();
  };

  function scheduleAnimationFrame() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      scanAtAnimationFrame();
    });
  }

  const observer = new MutationObserver(() => {
    mutationBatches += 1;
    scheduleAnimationFrame();
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "aria-expanded"],
  });
  scheduleAnimationFrame();

  Object.defineProperty(window, "__mobileHomeDomDiagnostic", {
    configurable: false,
    enumerable: false,
    value: {
      snapshot: () => ({
        timeOriginEpochMs: performance.timeOrigin,
        currentPerformanceNowMs: Number(performance.now().toFixed(3)),
        currentEpochMs: Number((performance.timeOrigin + performance.now()).toFixed(3)),
        mutationBatches,
        animationFrameScans: scans,
        targets,
      }),
    },
  });
}

async function installDelayedNetworkEvidence(page, { pageId, stage, delayMs }) {
  const events = [];
  const rpcMethodById = new Map();
  const pendingHttpTuples = new Map();
  let active = true;
  let pendingHttp = 0;
  let pendingWebSocket = 0;
  let droppedEvents = 0;
  let stoppedSnapshot = null;
  const record = event => {
    if (!active) return;
    if (events.length >= MAX_NETWORK_EVENTS) {
      droppedEvents += 1;
      return;
    }
    events.push({ pageId, stage, ...event });
  };

  await page.route("**/api/**", async route => {
    pendingHttp += 1;
    const request = route.request();
    const started = nodeMark();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (PENDING_HTTP_TUPLE_ALLOWLIST.includes(`${method} ${path}`)) {
      pendingHttpTuples.set(request, { pathname: path, method, started });
    }
    let response;
    try {
      response = await route.fetch();
      const upstreamResponse = nodeMark();
      const deadline = performance.now() + delayMs;
      await waitUntilDeadline(deadline);
      const appliedDelayMs = round(performance.now() - (upstreamResponse.monotonicMs));
      await route.fulfill({ response });
      record({
        kind: "http-response-forwarded",
        method,
        path,
        status: response.status(),
        requestStarted: started,
        upstreamResponse,
        forwarded: nodeMark(),
        configuredDelayMs: delayMs,
        appliedDelayMs,
      });
    } catch (error) {
      record({
        kind: "http-route-error",
        method,
        path,
        errorName: error?.name || "Error",
        at: nodeMark(),
      });
      await route.abort().catch(() => undefined);
    } finally {
      pendingHttp = Math.max(0, pendingHttp - 1);
      pendingHttpTuples.delete(request);
    }
  });

  await page.routeWebSocket(url => url.pathname.endsWith("/rpc"), socket => {
    const upstream = socket.connectToServer();
    let deliveryQueue = Promise.resolve();
    socket.onMessage(raw => {
      const frame = parseRpcFrame(raw);
      if (frame.method && frame.hasId) rpcMethodById.set(String(frame.id), frame.method);
      record({
        kind: frame.method ? "rpc-request-forwarded" : "rpc-frame-forwarded",
        direction: "page-to-gateway",
        method: frame.method,
        at: nodeMark(),
      });
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      const received = nodeMark();
      const frame = parseRpcFrame(raw);
      const method = frame.method || (frame.hasId ? rpcMethodById.get(String(frame.id)) ?? null : null);
      pendingWebSocket += 1;
      deliveryQueue = deliveryQueue.then(async () => {
        await waitUntilDeadline(received.monotonicMs + delayMs);
        socket.send(raw);
        const forwarded = nodeMark();
        record({
          kind: frame.method ? "rpc-notification-forwarded" : frame.hasId ? "rpc-response-forwarded" : "rpc-frame-forwarded",
          direction: "gateway-to-page",
          method,
          received,
          forwarded,
          configuredDelayMs: delayMs,
          appliedDelayMs: round(forwarded.monotonicMs - received.monotonicMs),
          rpcError: frame.hasError,
        });
        if (frame.hasId) rpcMethodById.delete(String(frame.id));
      }).catch(error => {
        record({ kind: "rpc-route-error", direction: "gateway-to-page", method, errorName: error?.name || "Error", at: nodeMark() });
      }).finally(() => {
        pendingWebSocket = Math.max(0, pendingWebSocket - 1);
      });
    });
  });

  return {
    stopCapture() {
      active = false;
      stoppedSnapshot = {
        at: nodeMark(),
        pendingHttp,
        pendingHttpTuples: [...pendingHttpTuples.values()].map(({ pathname, method, started: requestStarted }) => ({
          pathname,
          method,
          started: requestStarted,
        })),
        pendingHttpUnlistedCount: Math.max(0, pendingHttp - pendingHttpTuples.size),
        pendingWebSocket,
        pendingRpcMethods: [...rpcMethodById.values()].sort(),
      };
    },
    snapshot() {
      assert.ok(stoppedSnapshot, "network capture must be stopped before taking its final snapshot");
      return {
        pageId,
        stage,
        configuredResponseDelayMs: delayMs,
        events,
        eventCount: events.length,
        droppedEvents,
        pendingHttpAtCaptureStop: stoppedSnapshot.pendingHttp,
        pendingHttpAllowlistTuplesAtCaptureStop: stoppedSnapshot.pendingHttpTuples,
        pendingHttpUnlistedCountAtCaptureStop: stoppedSnapshot.pendingHttpUnlistedCount,
        pendingWebSocketAtCaptureStop: stoppedSnapshot.pendingWebSocket,
        rpcMethodsByPendingIdAtCaptureStop: stoppedSnapshot.pendingRpcMethods,
        captureEndedAt: stoppedSnapshot.at,
      };
    },
  };
}

function validateHomeNetworkEvidence(network, { pageId, stage }) {
  const events = Array.isArray(network.events) ? network.events : [];
  const networkSnapshotScopeMatches = network.pageId === pageId && network.stage === stage;
  const pendingHttpTuples = Array.isArray(network.pendingHttpAllowlistTuplesAtCaptureStop)
    ? network.pendingHttpAllowlistTuplesAtCaptureStop
    : [];
  const requirements = [
    {
      name: "GET /api/servers",
      matches: event => event.kind === "http-response-forwarded" && event.method === "GET" && event.path === "/api/servers",
      matchesFailure: event => event.kind === "http-route-error" && event.method === "GET" && event.path === "/api/servers",
      isSuccessful: event => Number.isInteger(event.status) && event.status >= 200 && event.status < 300,
      pendingTuple: pendingHttpTuples.find(tuple => tuple.method === "GET" && tuple.pathname === "/api/servers") ?? null,
    },
    {
      name: "RPC initialize response",
      matches: event => event.kind === "rpc-response-forwarded" && event.direction === "gateway-to-page" && event.method === "initialize",
      matchesFailure: event => event.kind === "rpc-route-error" && event.direction === "gateway-to-page" && event.method === "initialize",
      isSuccessful: event => event.rpcError !== true,
      pendingMethod: "initialize",
    },
    {
      name: "RPC thread/list response",
      matches: event => event.kind === "rpc-response-forwarded" && event.direction === "gateway-to-page" && event.method === "thread/list",
      matchesFailure: event => event.kind === "rpc-route-error" && event.direction === "gateway-to-page" && event.method === "thread/list",
      isSuccessful: event => event.rpcError !== true,
      pendingMethod: "thread/list",
    },
  ];
  const verifiedResponses = [];
  const missingOrInvalid = [];

  for (const requirement of requirements) {
    const matchingEvents = events.filter(requirement.matches);
    const scopedEvents = networkSnapshotScopeMatches
      ? matchingEvents.filter(event => event.pageId === pageId && event.stage === stage)
      : [];
    const validEvent = scopedEvents.find(event =>
      Number.isFinite(event.appliedDelayMs)
      && event.appliedDelayMs >= MIN_APPLIED_DELAY_MS
      && requirement.isSuccessful(event),
    );
    if (validEvent) {
      verifiedResponses.push({
        requirement: requirement.name,
        pageId: validEvent.pageId,
        stage: validEvent.stage,
        appliedDelayMs: validEvent.appliedDelayMs,
        ...(Object.hasOwn(validEvent, "status") ? { responseStatus: validEvent.status } : {}),
      });
      continue;
    }

    const scopedFailureEvents = events.filter(event =>
      requirement.matchesFailure(event) && event.pageId === pageId && event.stage === stage,
    );
    const pendingRpc = requirement.pendingMethod
      ? (network.rpcMethodsByPendingIdAtCaptureStop ?? []).includes(requirement.pendingMethod)
      : false;
    let reason;
    if (scopedEvents.length > 0) {
      const candidate = scopedEvents[0];
      if (!Number.isFinite(candidate.appliedDelayMs)) reason = "forwarded-response-missing-or-nonfinite-appliedDelayMs";
      else if (candidate.appliedDelayMs < MIN_APPLIED_DELAY_MS) reason = "forwarded-response-appliedDelayMs-below-minimum";
      else if (!requirement.isSuccessful(candidate)) reason = "forwarded-response-was-not-successful";
      else reason = "no-valid-forwarded-response";
    } else if (!networkSnapshotScopeMatches) {
      reason = "network-snapshot-pageId-or-stage-mismatch";
    } else if (matchingEvents.length > 0) {
      reason = "matching-response-was-tagged-with-a-different-pageId-or-stage";
    } else if (scopedFailureEvents.length > 0) {
      reason = "route-failed-before-response-was-forwarded";
    } else if (requirement.pendingTuple || pendingRpc) {
      reason = "request-pending-at-capture-stop-before-response-was-forwarded";
    } else if (network.droppedEvents > 0) {
      reason = "response-not-observed-and-capture-dropped-events";
    } else {
      reason = "required-forwarded-response-not-observed-before-capture-stop";
    }
    missingOrInvalid.push({
      requirement: requirement.name,
      reason,
      matchingResponseCount: scopedEvents.length,
      matchingResponseOutsideScopeCount: matchingEvents.length - scopedEvents.length,
      matchingRouteErrorCount: scopedFailureEvents.length,
      ...(requirement.pendingTuple ? { pendingHttpTuple: requirement.pendingTuple } : {}),
      ...(pendingRpc ? { pendingRpcMethod: requirement.pendingMethod } : {}),
      ...(scopedEvents[0] ? {
        observed: {
          pageId: scopedEvents[0].pageId,
          stage: scopedEvents[0].stage,
          appliedDelayMs: scopedEvents[0].appliedDelayMs ?? null,
          ...(Object.hasOwn(scopedEvents[0], "status") ? { responseStatus: scopedEvents[0].status } : {}),
          ...(Object.hasOwn(scopedEvents[0], "rpcError") ? { rpcError: scopedEvents[0].rpcError } : {}),
        },
      } : {}),
      captureDroppedEvents: network.droppedEvents ?? 0,
    });
  }

  return {
    status: missingOrInvalid.length === 0 ? "DIAGNOSTIC_COMPLETE" : "INCOMPLETE",
    networkSnapshotScopeMatches,
    requiredMinimumAppliedDelayMs: MIN_APPLIED_DELAY_MS,
    verifiedResponses,
    missingOrInvalid,
  };
}

async function listBundleFiles(root) {
  const files = [];
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = resolve(directory, entry.name);
      const info = await lstat(absolute);
      assert.ok(!info.isSymbolicLink(), `pinned bundle cannot contain symlinks: ${path}`);
      if (info.isDirectory()) await visit(absolute, path);
      else {
        assert.ok(info.isFile(), `pinned bundle contains a special file: ${path}`);
        files.push(path);
      }
    }
  }
  await visit(root);
  return files.sort();
}

function parseRpcFrame(raw) {
  try {
    const frame = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    return {
      method: typeof frame?.method === "string" ? frame.method : null,
      hasId: Object.hasOwn(frame ?? {}, "id"),
      id: frame?.id,
      hasError: Object.hasOwn(frame ?? {}, "error"),
    };
  } catch {
    return { method: null, hasId: false, id: null, hasError: false };
  }
}

async function waitUntilDeadline(deadline) {
  while (deadline - performance.now() > 0) {
    const remainingMs = deadline - performance.now();
    await new Promise(resolveDelay => setTimeout(resolveDelay, Math.ceil(remainingMs)));
  }
}

function summarizeBundle(bundle) {
  return {
    snapshot: bundle.snapshot,
    bundleRoot: repoRelative(bundle.bundleRoot),
    manifestPath: repoRelative(bundle.manifestPath),
    manifestSha256: bundle.manifestSha256,
    sourceTreeSha256: bundle.sourceTreeSha256,
    bundleSha256: bundle.bundleSha256,
    indexHtmlSha256: bundle.indexHtmlSha256,
    bundleFileCount: bundle.bundleFileCount,
  };
}

function assertSafeBundlePath(path) {
  assert.ok(typeof path === "string" && path.length > 0 && path.length <= 1024, "Mobile Web bundle path is invalid");
  assert.ok(!path.startsWith("/") && !path.includes("\\") && !path.includes("\0"), "Mobile Web bundle path must be relative and POSIX-formatted");
  assert.ok(path.split("/").every(part => part && part !== "." && part !== ".."), "Mobile Web bundle path contains an unsafe segment");
}

function isWithin(root, candidate) {
  const child = relative(resolve(root), resolve(candidate));
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep);
}

function repoRelative(path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function nodeMark() {
  return { epochMs: Date.now(), monotonicMs: round(performance.now()) };
}

function round(value) {
  return Number(value.toFixed(3));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
