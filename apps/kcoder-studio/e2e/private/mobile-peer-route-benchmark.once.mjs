// One-shot real-Mobile-Web LAN/P2P/Relay transport benchmark.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { runE2E } from "../harness/run-context.mjs";
import { downloadOwnedCertutil, initializeIsolatedChromiumTrust } from "./mobile-route-lan-https-front.mjs";
import { isLoopbackGatewayConnectionUrl, parseGatewayConnectionRoutes } from "../../shared/gatewayConnectionRoutes.js";

const RUN_FLAG = "KCODER_E2E_PRIVATE_MOBILE_PEER_ROUTE_BENCHMARK";
const CONFIG_ENV = "KCODER_E2E_PRIVATE_MOBILE_PEER_ROUTE_BENCHMARK_CONFIG";
const PUBLIC_GET_ONLY_FLAG = "KCODER_E2E_PRIVATE_MOBILE_PEER_ROUTE_PUBLIC_GET_ONLY";
const PUBLIC_GET_BUNDLE_FLAG = "KCODER_E2E_PRIVATE_MOBILE_PEER_ROUTE_PUBLIC_GET_WITH_BUNDLE";
const PUBLIC_BENCHMARK_ONLY_FLAG = "KCODER_E2E_PRIVATE_MOBILE_PEER_ROUTE_PUBLIC_BENCHMARK_ONLY";
const DEFAULT_BUDGET_DIAGNOSTIC_FLAG = "KCODER_E2E_PRIVATE_MOBILE_PEER_ROUTE_DEFAULT_BUDGET_DIAGNOSTIC";
const CONFIG_KEYS = new Set(["schemaVersion", "browser", "bundle", "fixture", "lan", "public", "mobileWebExport"]);
const EXPECTED_LAN_GATEWAY_IP = "10.31.6.5";
const EXPECTED_PUBLIC_RELAY_ORIGIN = "https://hyf2333.top:8451";
const EXPECTED_PUBLIC_RELAY_IP = "47.80.92.250";
const PAIR_NAVIGATION_BUDGET_MS = 120_000;
const RUN_FLAG_SET = process.env[RUN_FLAG] === "1";
const PUBLIC_GET_ONLY = process.env[PUBLIC_GET_ONLY_FLAG] === "1";
const PUBLIC_GET_WITH_BUNDLE = process.env[PUBLIC_GET_BUNDLE_FLAG] === "1";
const PUBLIC_BENCHMARK_ONLY = process.env[PUBLIC_BENCHMARK_ONLY_FLAG] === "1";
const DEFAULT_BUDGET_DIAGNOSTIC = process.env[DEFAULT_BUDGET_DIAGNOSTIC_FLAG] === "1";
const ATTACHMENT_TIMEOUT_MS = DEFAULT_BUDGET_DIAGNOSTIC ? 30_000 : 10_000;
const noSandbox = process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1";
const requireSandbox = process.env.KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX === "1";

assert.equal(RUN_FLAG_SET, true, `${RUN_FLAG}=1 is required for this private one-shot benchmark`);
assert.ok(process.env[PUBLIC_GET_ONLY_FLAG] === undefined || process.env[PUBLIC_GET_ONLY_FLAG] === "0" || PUBLIC_GET_ONLY,
  `${PUBLIC_GET_ONLY_FLAG} must be unset, 0, or 1`);
assert.ok(process.env[PUBLIC_GET_BUNDLE_FLAG] === undefined || process.env[PUBLIC_GET_BUNDLE_FLAG] === "0" || PUBLIC_GET_WITH_BUNDLE,
  `${PUBLIC_GET_BUNDLE_FLAG} must be unset, 0, or 1`);
assert.ok(!PUBLIC_GET_WITH_BUNDLE || PUBLIC_GET_ONLY, `${PUBLIC_GET_BUNDLE_FLAG}=1 requires public GET-only diagnostic mode`);
assert.ok(process.env[PUBLIC_BENCHMARK_ONLY_FLAG] === undefined || process.env[PUBLIC_BENCHMARK_ONLY_FLAG] === "0" || PUBLIC_BENCHMARK_ONLY,
  `${PUBLIC_BENCHMARK_ONLY_FLAG} must be unset, 0, or 1`);
assert.ok(!PUBLIC_GET_ONLY || !PUBLIC_BENCHMARK_ONLY, "public GET diagnostics and public benchmark mode are mutually exclusive");
assert.ok(process.env[DEFAULT_BUDGET_DIAGNOSTIC_FLAG] === undefined || process.env[DEFAULT_BUDGET_DIAGNOSTIC_FLAG] === "0" || DEFAULT_BUDGET_DIAGNOSTIC,
  `${DEFAULT_BUDGET_DIAGNOSTIC_FLAG} must be unset, 0, or 1`);
assert.ok(!DEFAULT_BUDGET_DIAGNOSTIC || PUBLIC_BENCHMARK_ONLY,
  `${DEFAULT_BUDGET_DIAGNOSTIC_FLAG}=1 requires ${PUBLIC_BENCHMARK_ONLY_FLAG}=1`);
assert.notEqual(noSandbox, requireSandbox, "set exactly one of KCODER_E2E_CHROMIUM_NO_SANDBOX=1 or KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX=1");
const configPath = process.env[CONFIG_ENV];
assert.equal(typeof configPath, "string", `${CONFIG_ENV} must point to a private JSON config`);
const config = await readPrivateConfig(configPath);
validateConfig(config);

await runE2E(import.meta.url, {
  testId: PUBLIC_GET_ONLY
    ? PUBLIC_GET_WITH_BUNDLE ? "mobile-peer-route-public-get-with-bundle-diagnostic" : "mobile-peer-route-public-get-diagnostic"
    : PUBLIC_BENCHMARK_ONLY
      ? DEFAULT_BUDGET_DIAGNOSTIC ? "mobile-peer-route-public-p2p-relay-default-budget-diagnostic" : "mobile-peer-route-public-p2p-relay-benchmark"
      : "mobile-peer-route-three-path-benchmark",
  tier: "manual-live",
  retainSuccessLogs: true,
  modelPolicy: PUBLIC_GET_ONLY
    ? `${PUBLIC_GET_WITH_BUNDLE ? "pinned benchmark adapter injected; " : "no benchmark bundle; "}public unauthenticated Mobile connect GET only; fresh RunContext-owned Chromium; no token, pairing, benchmark transport, personal session, provider call, export, shared development port, or benchmark acceptance`
    : PUBLIC_BENCHMARK_ONLY
      ? `real public Mobile Web pairing and production GatewayRpcClient/route resolver/peer transport in RunContext-owned Chromium; public P2P and canonical Relay only; previous LAN evidence is separate; test-only fixed attachment fixture${DEFAULT_BUDGET_DIAGNOSTIC ? "; additional default-budget attachment timeout diagnostic" : ""}; no personal session, model/provider call, export, or shared development port`
    : "real Mobile Web pairing and production gatewayRequest/GatewayRpcClient/route resolver/peer transport in RunContext-owned Chromium; test-only fixed attachment fixture; no personal session, model/provider call, export, shared development port, or full-UI acceptance",
}, async context => {
  for (const lane of [config.lan, config.public]) {
    context.registerSecret(lane.pairingToken);
    context.registerSecret(lane.publicBaseUrl);
    context.registerSecret(lane.mobileConnectUrl);
    context.registerSecret(JSON.stringify(lane.connectionRoutes));
  }
  if (config.fixture.threadId.length >= 8) context.registerSecret(config.fixture.threadId);
  if (PUBLIC_GET_ONLY) return await runPublicGetOnlyDiagnostic(context, config);
  const safeReport = {
    status: "running",
    runScope: PUBLIC_BENCHMARK_ONLY
      ? DEFAULT_BUDGET_DIAGNOSTIC
        ? "public-p2p-and-relay-only; additional default-budget diagnostic (30s per attachment RPC, 2s RTT unchanged, fixed fixture and hash gate unchanged); LAN is covered by a separate retained run"
        : "public-p2p-and-relay-only; LAN is covered by a separate retained run"
      : "lan-public-p2p-public-relay",
    attachmentTimeoutMs: ATTACHMENT_TIMEOUT_MS,
    boundary: "transport-only real Mobile Web page; LAN and public Gateway endpoints are separately reported; public-p2p and canonical Relay use the same public Gateway/client identity; no raw/demo transport",
    topology: {
      lan: { mobileConnectUrl: safeUrl(config.lan.mobileConnectUrl), gatewayBaseUrl: safeUrl(config.lan.publicBaseUrl), gatewayIps: config.lan.expectedGatewayIps, clientIps: config.lan.expectedClientIps },
      public: { mobileConnectUrl: safeUrl(config.public.mobileConnectUrl), gatewayBaseUrl: safeUrl(config.public.publicBaseUrl), gatewayIps: config.public.expectedGatewayIps, clientIps: config.public.expectedClientIps },
      expectedStunUrl: config.public.stunUrl,
      relayMeasurement: "browser-visible public request/RPC route and Chromium TCP peer for the strict-TLS Mobile origin; no server ingress counter in this runner",
    },
    fixture: {
      source: "RunContext-owned deterministic app-server attachment fixture",
      objectBytes: config.fixture.size,
      payloadSha256: config.fixture.sha256,
      chunkBytes: config.fixture.chunkBytes,
      repetitionsPerPath: config.fixture.repetitions,
    },
    source: {
      mobileWebExport: safeMobileWebExport(config.mobileWebExport),
      browserBundle: { sha256: config.bundle.sha256, entrySourceSha256: config.bundle.entrySourceSha256, mobileSourceTreeSha256: config.bundle.mobileSourceTreeSha256, sharedSourceTreeSha256: config.bundle.sharedSourceTreeSha256 },
    },
    lanes: {},
  };

  let activeChromium;
  let activePage;
  const lanePages = new Map();
  const cleanupNetworkObservations = [];
  const cleanupObservationByRequest = new WeakMap();
  const cleanupCandidates = new Map();
  const cleanupAttemptedBaseUrls = new Set();
  const oldUmask = process.umask(0o077);
  const chromiumHome = context.pathInState("chromium-home");
  let lanChromiumEnv;
  try {
    await mkdir(chromiumHome, { recursive: true, mode: 0o700 });
    if (config.browser.caTrust && !PUBLIC_BENCHMARK_ONLY) {
      const certutilPath = await downloadOwnedCertutil(context);
      const caInfo = await lstat(config.browser.caTrust.certificatePath);
      assert.ok(caInfo.isFile() && !caInfo.isSymbolicLink() && caInfo.nlink === 1, "LAN CA input must be a regular single-link public certificate file");
      const caCertificatePem = await readFile(config.browser.caTrust.certificatePath, "utf8");
      const trust = await initializeIsolatedChromiumTrust(context, {
        caCertificatePem,
        expectedCaSha256: config.browser.caTrust.certificateSha256,
        certutilPath,
        nickname: config.browser.caTrust.nickname,
        home: chromiumHome,
      });
      lanChromiumEnv = trust.chromiumEnv;
    }
    const bundleBytes = await readFile(config.bundle.path);
    assert.equal(createHash("sha256").update(bundleBytes).digest("hex"), config.bundle.sha256, "browser bundle SHA-256 differs from private config");
    const entryBytes = await readFile(new URL("./mobile-peer-route-benchmark.browser.ts", import.meta.url));
    assert.equal(createHash("sha256").update(entryBytes).digest("hex"), config.bundle.entrySourceSha256, "browser adapter source SHA-256 differs from private config");
    assert.equal(config.mobileWebExport.sourceTreeSha256, config.bundle.mobileSourceTreeSha256, "browser adapter Mobile source pin must match the verified Mobile Web export source tree");
    const bundleText = bundleBytes.toString("utf8");
    assert.ok(bundleText.includes("__runMobilePeerRouteBenchmark"), "browser bundle must expose the Mobile transport benchmark entry");

    const startLaneBrowser = async laneName => {
      const chromiumOptions = {
        label: `mobile-peer-route-benchmark-${laneName}-browser`,
        profileName: `mobile-peer-route-benchmark-${laneName}`,
        executablePath: config.browser.executablePath,
        noSandbox,
        windowSize: { width: 390, height: 844 },
      };
      if (laneName === "lan" && lanChromiumEnv) chromiumOptions.env = lanChromiumEnv;
      const chromium = await startChromium(context, chromiumOptions);
      activeChromium = chromium;
      activePage = await chromium.newPersistentPage();
      const page = activePage;
      lanePages.set(config[laneName].publicBaseUrl, page);
      page.on("request", request => {
        const endpoint = safeIdentityDeleteEndpoint(request.url(), request.method());
        if (!endpoint) return;
        const authorization = request.headers().authorization;
        const observation = {
          endpoint,
          authorizationHeaderPresent: typeof authorization === "string" && /^Bearer\s+\S+$/i.test(authorization),
          status: null,
          ok: null,
          failureCode: null,
        };
        cleanupNetworkObservations.push(observation);
        cleanupObservationByRequest.set(request, observation);
      });
      page.on("response", response => {
        const observation = cleanupObservationByRequest.get(response.request());
        if (!observation) return;
        observation.status = response.status();
        observation.ok = response.ok();
      });
      page.on("requestfailed", request => {
        const observation = cleanupObservationByRequest.get(request);
        if (observation) observation.failureCode = safeNetworkFailureCode(request.failure()?.errorText);
      });
      await page.addInitScript({ content: bundleText });
      safeReport.browsers ??= {};
      safeReport.browsers[laneName] = {
        version: chromium.browser.version(),
        executablePath: chromium.executablePath,
        profile: "RunContext-owned isolated Chromium profile",
        home: laneName === "lan" && lanChromiumEnv
          ? "RunContext-owned isolated HOME with isolated LAN NSS trust"
          : "RunContext-owned isolated HOME with system trust",
      };
      safeReport.browser ??= {
        version: chromium.browser.version(),
        executablePath: chromium.executablePath,
        home: "RunContext-owned isolated HOME; trust mode is recorded per lane in browsers",
      };
      return page;
    };
    const closeActiveBrowser = async () => {
      if (!activeChromium) return;
      const closing = activeChromium;
      await closing.close();
      activeChromium = undefined;
      activePage = undefined;
    };

    const runPublicLane = async () => {
      const publicPage = await startLaneBrowser("public");
      await publicPage.route("**/*", route => route.continue());
      safeReport.browsers.public.requestRouting = {
        enabled: true,
        handler: "continue-all-unmodified",
        httpCache: "disabled-by-Playwright-page.route",
      };
      const publicNavigationTrace = createNavigationTrace(publicPage);
      safeReport.lanes.publicPairing = await captureLaneFailure(context, "public-pairing", async () =>
        pairLane(publicPage, config.public, cleanupCandidates, EXPECTED_PUBLIC_RELAY_IP, publicNavigationTrace));
      safeReport.lanes.publicPairing.navigationBudgetMs = PAIR_NAVIGATION_BUDGET_MS;
      safeReport.lanes.publicPairing.navigationTrace = publicNavigationTrace.events;
      if (safeReport.lanes.publicPairing.status === "paired") {
        safeReport.lanes.publicP2p = await captureLaneFailure(context, "public-p2p-measurement", async () =>
          measureLane(publicPage, config.public, "public-p2p", config.fixture));
        safeReport.lanes.publicRelay = await captureLaneFailure(context, "public-relay-measurement", async () =>
          measureLane(publicPage, config.public, "public-relay", config.fixture));
      } else {
        safeReport.lanes.publicP2p = { mode: "public-p2p", status: "unavailable-pairing", quality: { measurementComplete: false } };
        safeReport.lanes.publicRelay = { mode: "public-relay", status: "unavailable-pairing", quality: { measurementComplete: false } };
      }
      safeReport.lanes.publicIdentityCleanup = await cleanupDeviceOnce(publicPage, config.public.publicBaseUrl, cleanupCandidates, cleanupAttemptedBaseUrls, cleanupNetworkObservations);
      await closeActiveBrowser();
    };

    if (PUBLIC_BENCHMARK_ONLY) {
      safeReport.lanes.lanPairing = { status: "not-run-public-only" };
      safeReport.lanes.lan = { mode: "lan", status: "not-run-public-only", quality: { measurementComplete: false } };
      safeReport.lanes.lanIdentityCleanup = { attempted: false, status: "not-run-public-only" };
      await runPublicLane();
    } else {
      const lanPage = await startLaneBrowser("lan");
      const lanNavigationTrace = createNavigationTrace(lanPage);
      safeReport.lanes.lanPairing = await captureLaneFailure(context, "lan-pairing", async () =>
        pairLane(lanPage, config.lan, cleanupCandidates, EXPECTED_LAN_GATEWAY_IP, lanNavigationTrace));
      safeReport.lanes.lanPairing.navigationBudgetMs = PAIR_NAVIGATION_BUDGET_MS;
      safeReport.lanes.lanPairing.navigationTrace = lanNavigationTrace.events;
      if (safeReport.lanes.lanPairing.status === "paired") {
        safeReport.lanes.lan = await captureLaneFailure(context, "lan-measurement", async () =>
          measureLane(lanPage, config.lan, "lan", config.fixture));
      } else safeReport.lanes.lan = { mode: "lan", status: "unavailable-pairing", quality: { measurementComplete: false } };
      safeReport.lanes.lanIdentityCleanup = await cleanupDeviceOnce(lanPage, config.lan.publicBaseUrl, cleanupCandidates, cleanupAttemptedBaseUrls, cleanupNetworkObservations);
      await closeActiveBrowser();
      await runPublicLane();
    }
    const measurements = PUBLIC_BENCHMARK_ONLY
      ? [safeReport.lanes.publicP2p, safeReport.lanes.publicRelay]
      : [safeReport.lanes.lan, safeReport.lanes.publicP2p, safeReport.lanes.publicRelay];
    const cleanupComplete = PUBLIC_BENCHMARK_ONLY
      ? safeReport.lanes.publicIdentityCleanup?.status === "revoked"
      : safeReport.lanes.lanIdentityCleanup?.status === "revoked" && safeReport.lanes.publicIdentityCleanup?.status === "revoked";
    safeReport.cleanupComplete = cleanupComplete;
    safeReport.status = cleanupComplete && measurements.every(value => value?.quality?.measurementComplete === true) ? "pass" : "partial";
  } catch (error) {
    safeReport.status = "failed";
    safeReport.failure = safeFailure(context, error);
    throw error;
  } finally {
    if (activePage) {
      for (const [baseUrl, expectedDeviceId] of cleanupCandidates) {
        if (cleanupAttemptedBaseUrls.has(baseUrl)) continue;
        cleanupAttemptedBaseUrls.add(baseUrl);
        const ownerPage = lanePages.get(baseUrl);
        const cleanup = ownerPage && !ownerPage.isClosed()
          ? await revokeDevice(ownerPage, baseUrl, expectedDeviceId, cleanupNetworkObservations).catch(() => ({ attempted: false, status: "cleanup-unavailable", retry: false }))
          : { attempted: false, status: "cleanup-unavailable", retry: false };
        if (baseUrl === config.lan.publicBaseUrl) safeReport.lanes.lanIdentityCleanup = cleanup;
        if (baseUrl === config.public.publicBaseUrl) safeReport.lanes.publicIdentityCleanup = cleanup;
      }
    }
    try {
      await context.writeArtifactJson("mobile-peer-route-benchmark.json", safeReport);
    } finally {
      try {
        if (activeChromium) await activeChromium.close();
      } finally {
        process.umask(oldUmask);
      }
    }
  }
  if (safeReport.status !== "pass") throw new Error(`MOBILE_PEER_ROUTE_BENCHMARK_${safeReport.status.toUpperCase()}`);
  return { status: safeReport.status, lanes: Object.keys(safeReport.lanes) };
});

async function runPublicGetOnlyDiagnostic(context, config) {
  const lane = config.public;
  const expectedUrl = new URL(lane.mobileConnectUrl);
  assert.equal(expectedUrl.search, "", "public GET diagnostic URL cannot contain query parameters");
  assert.equal(expectedUrl.hash, "", "public GET diagnostic URL cannot contain a fragment or pairing token");
  const oldUmask = process.umask(0o077);
  const report = {
    status: "running",
    benchmarkAcceptance: false,
    boundary: PUBLIC_GET_WITH_BUNDLE
      ? "strict-TLS unauthenticated same-origin GET only; pinned adapter injected but not invoked; no pairing token, POST, device identity, P2P, Relay RPC, or benchmark PASS"
      : "strict-TLS unauthenticated same-origin GET only; no pairing token, POST, device identity, benchmark bundle, P2P, Relay RPC, or benchmark PASS",
    target: safeUrl(lane.mobileConnectUrl),
    expectedServerIp: EXPECTED_PUBLIC_RELAY_IP,
    requestGuard: {
      allowed: "GET to the configured public Mobile origin without Cookie or Authorization",
      responseMutation: false,
      playwrightRoutingEnabled: true,
      httpCache: "disabled-by-Playwright-page.route",
      blockedCount: 0,
      blockedReasons: [],
    },
    navigationTrace: [],
  };
  const ipMonitor = startOwnedIpMonitor(context);
  let chromium;
  let trace;
  let diagnosticError;
  let bundleText;
  const blockedReasons = new Set();
  try {
    if (PUBLIC_GET_WITH_BUNDLE) {
      const bundleBytes = await readFile(config.bundle.path);
      assert.equal(createHash("sha256").update(bundleBytes).digest("hex"), config.bundle.sha256, "browser bundle SHA-256 differs from private config");
      const entryBytes = await readFile(new URL("./mobile-peer-route-benchmark.browser.ts", import.meta.url));
      assert.equal(createHash("sha256").update(entryBytes).digest("hex"), config.bundle.entrySourceSha256, "browser adapter source SHA-256 differs from private config");
      assert.equal(config.mobileWebExport.sourceTreeSha256, config.bundle.mobileSourceTreeSha256, "browser adapter Mobile source pin must match the verified Mobile Web export source tree");
      bundleText = bundleBytes.toString("utf8");
      assert.ok(bundleText.includes("__runMobilePeerRouteBenchmark"), "browser bundle must expose the Mobile transport benchmark entry");
      report.browserBundle = {
        injected: true,
        invoked: false,
        sha256: config.bundle.sha256,
        entrySourceSha256: config.bundle.entrySourceSha256,
        mobileSourceTreeSha256: config.bundle.mobileSourceTreeSha256,
      };
      report.requestGuard.profile = "same GET-only route guard as the no-bundle diagnostic; routing disables HTTP cache";
    } else {
      report.browserBundle = { injected: false, invoked: false };
      report.requestGuard.profile = "same GET-only route guard as the bundle diagnostic; routing disables HTTP cache";
    }
    chromium = await startChromium(context, {
      label: "mobile-peer-route-public-get-diagnostic-browser",
      profileName: "mobile-peer-route-public-get-diagnostic",
      executablePath: config.browser.executablePath,
      noSandbox,
      windowSize: { width: 390, height: 844 },
    });
    report.browser = {
      version: chromium.browser.version(),
      executablePath: chromium.executablePath,
      profile: "RunContext-owned fresh profile; strict browser-default TLS trust",
    };
    const page = await chromium.newPersistentPage();
    trace = createNavigationTrace(page);
    if (PUBLIC_GET_WITH_BUNDLE) await page.addInitScript({ content: bundleText });
    await page.route("**/*", async route => {
      const request = route.request();
      const headers = await request.allHeaders().catch(() => ({}));
      let requestOrigin;
      try { requestOrigin = new URL(request.url()).origin; } catch { requestOrigin = ""; }
      let reason;
      if (request.method() !== "GET") reason = "non-GET-method";
      else if (requestOrigin !== expectedUrl.origin) reason = "cross-origin";
      else if (headers.authorization) reason = "authorization-header-present";
      else if (headers.cookie) reason = "cookie-header-present";
      if (reason) {
        report.requestGuard.blockedCount += 1;
        blockedReasons.add(reason);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });

    trace.setPhase("public-connect-get");
    const response = await page.goto(lane.mobileConnectUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert.ok(response && response.status() >= 200 && response.status() < 400, "public Mobile connect GET must return a successful browser response");
    assert.equal(new URL(response.url()).origin, expectedUrl.origin, "public connect GET must remain on the configured origin");
    const serverAddress = await response.serverAddr();
    assert.ok(serverAddress && isIP(serverAddress.ipAddress) > 0 && Number.isInteger(serverAddress.port),
      "Chromium must expose the TCP peer for the public connect GET");
    assert.equal(serverAddress.ipAddress, EXPECTED_PUBLIC_RELAY_IP, "public connect GET must terminate at the expected Relay host");
    trace.recordNavigation("public-connect-get", response.status(), serverAddress);

    trace.setPhase("react-connect-readiness");
    const retryControl = page.getByTestId("pairing-retry");
    await retryControl.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await retryControl.isEnabled(), true, "Mobile React connect route must render an interactive retry control");
    trace.markReadyControl();

    trace.setPhase("critical-script-settle");
    await trace.waitForCriticalScripts(15_000);
    report.requestGuard.blockedReasons = [...blockedReasons].sort();
    assert.equal(report.requestGuard.blockedCount, 0, "public diagnostic attempted a blocked credentialed, cross-origin, or non-GET request");
    report.tcpPeer = { ipAddress: serverAddress.ipAddress, port: serverAddress.port };
    report.status = "diagnostic-only-complete";
  } catch (error) {
    report.requestGuard.blockedReasons = [...blockedReasons].sort();
    report.status = "diagnostic-only-failed";
    diagnosticError = safePairingDiagnostic(trace?.currentPhase || "public-connect-get", error);
    report.failure = safeFailure(context, diagnosticError);
  } finally {
    try {
      report.navigationTrace = trace?.events || [];
      report.ipMonitor = await ipMonitor.stop();
      await context.writeArtifactJson("mobile-peer-route-public-get-diagnostic.json", report).catch(() => undefined);
      if (chromium) await chromium.close();
    } finally {
      process.umask(oldUmask);
    }
  }
  if (diagnosticError) throw new Error("MOBILE_PEER_ROUTE_PUBLIC_GET_DIAGNOSTIC_FAILED");
  return { status: "diagnostic-only", benchmarkAcceptance: false, report: "mobile-peer-route-public-get-diagnostic.json" };
}

function startOwnedIpMonitor(context) {
  const label = "mobile-peer-route-public-get-ip-monitor";
  const startedAtUtc = new Date().toISOString();
  const startedAtMs = Date.now();
  let spawned = false;
  let spawnError;
  let stopError;
  try {
    context.spawnOwned(label, "ip", ["-ts", "monitor", "address", "link", "route"]);
    spawned = true;
  } catch (error) {
    spawnError = safeErrorName(error);
  }
  const stopPromise = new Promise(resolveStop => {
    setTimeout(async () => {
      if (spawned) {
        try { await context.stopOwned(label); }
        catch (error) { stopError = safeErrorName(error); }
      }
      resolveStop();
    }, 20_000);
  });

  return {
    async stop() {
      await stopPromise;
      const endedAtUtc = new Date().toISOString();
      const processRecord = context.processes?.get(label);
      let raw = "";
      if (processRecord?.logPath) raw = await readFile(processRecord.logPath, "utf8").catch(() => "");
      const events = raw.split(/\r?\n/).filter(line => line.trim());
      const interfaceCounts = {};
      const samples = [];
      for (const line of events) {
        const monitorLine = line.replace(/^20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*/, "");
        const interfaceName = monitorLine.match(/\bdev\s+([A-Za-z0-9_.:@-]+)/)?.[1] || monitorLine.match(/(?:^|\s)\d+:\s*([^\s:]+):/)?.[1] || null;
        if (interfaceName) interfaceCounts[interfaceName] = (interfaceCounts[interfaceName] || 0) + 1;
        if (samples.length < 80) {
          const timestamp = line.match(/20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?/)?.[0] || null;
          const change = /^\s*Deleted\b/i.test(monitorLine) ? "deleted"
            : /\bNO-CARRIER\b/i.test(monitorLine) ? "no-carrier"
              : /\bDOWN\b/i.test(monitorLine) ? "down"
                : /\bLOWER_UP\b/i.test(monitorLine) ? "lower-up"
                  : /\bUP\b/i.test(monitorLine) ? "up" : "updated";
          samples.push({ timestamp, interface: interfaceName, change });
        }
      }
      return {
        status: spawnError || processRecord?.spawnError ? "spawn-failed" : stopError ? "stop-failed" : processRecord?.stopped ? "stopped" : "unknown",
        startedAtUtc,
        endedAtUtc,
        windowMs: Date.now() - startedAtMs,
        eventCount: events.length,
        interfaceCounts,
        physicalWanInterfaceEventCount: interfaceCounts.enp24s0f1 || 0,
        vethEventCount: Object.entries(interfaceCounts).filter(([name]) => name.startsWith("veth")).reduce((sum, [, count]) => sum + count, 0),
        samples,
        ...(spawnError ? { spawnError } : {}),
        ...(stopError ? { stopError } : {}),
      };
    },
  };
}

async function pairLane(page, lane, cleanupCandidates, expectedServerIp, navigationTrace) {
  // addInitScript runs for the next document; bootstrap on this lane's real origin
  // before inspecting origin-scoped Mobile storage or comparing fresh identities.
  let phase = "bootstrap-navigation";
  let priorIds = [];
  navigationTrace.setPhase(phase);
  try {
    const bootstrapResponse = await page.goto(lane.mobileConnectUrl, { waitUntil: "domcontentloaded", timeout: PAIR_NAVIGATION_BUDGET_MS });
    assert.ok(bootstrapResponse && bootstrapResponse.status() >= 200 && bootstrapResponse.status() < 400,
      "actual Mobile connect bootstrap page must return a successful browser response");
    assert.equal(new URL(bootstrapResponse.url()).origin, new URL(lane.mobileConnectUrl).origin,
      "Mobile connect bootstrap must remain on the configured owned HTTPS origin");
    const bootstrapServerAddress = await bootstrapResponse.serverAddr();
    assert.ok(bootstrapServerAddress && isIP(bootstrapServerAddress.ipAddress) > 0 && Number.isInteger(bootstrapServerAddress.port),
      "Chromium must expose the actual TCP peer for the Mobile bootstrap response");
    assert.equal(bootstrapServerAddress.ipAddress, expectedServerIp, "Mobile bootstrap response must terminate at the expected owned Gateway/Relay host");
    navigationTrace.recordNavigation("bootstrap", bootstrapResponse.status(), bootstrapServerAddress);

    phase = "bootstrap-react-readiness";
    navigationTrace.setPhase(phase);
    await page.waitForFunction(() => typeof window.__listMobilePeerRouteBenchmarkDeviceIdentities === "function", null, { timeout: 15_000 });
    const retryControl = page.getByTestId("pairing-retry");
    await retryControl.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await retryControl.isEnabled(), true, "Mobile React connect route must expose an interactive pairing retry control before token navigation");
    navigationTrace.markReadyControl();

    phase = "bootstrap-script-settle";
    navigationTrace.setPhase(phase);
    await navigationTrace.waitForCriticalScripts(15_000);

    phase = "identity-baseline";
    navigationTrace.setPhase(phase);
    priorIds = await readDeviceIdentities(page, lane.publicBaseUrl);
    const started = performance.now();

    phase = "pairing-navigation";
    navigationTrace.setPhase(phase);
    const pairingUrl = makePairingUrl(lane);
    const response = await page.goto(pairingUrl, { waitUntil: "domcontentloaded", timeout: PAIR_NAVIGATION_BUDGET_MS });
    assert.ok(response && response.status() >= 200 && response.status() < 400, "actual Mobile connect page must return a successful browser response");
    assert.equal(new URL(response.url()).origin, new URL(lane.mobileConnectUrl).origin, "Mobile connect navigation must remain on the configured owned HTTPS origin");
    const serverAddress = await response.serverAddr();
    assert.ok(serverAddress && isIP(serverAddress.ipAddress) > 0 && Number.isInteger(serverAddress.port),
      "Chromium must expose the actual TCP peer for the Mobile connect response");
    assert.equal(serverAddress.ipAddress, expectedServerIp, "Mobile connect response must terminate at the expected owned Gateway/Relay host");
    navigationTrace.recordNavigation("pairing", response.status(), serverAddress);
    assert.equal(new URL(lane.mobileConnectUrl).origin, new URL(lane.publicBaseUrl).origin,
      "Mobile page and signed Gateway request route must share the measured origin");
    phase = "token-scrub";
    navigationTrace.setPhase(phase);
    await page.waitForFunction(() => !location.hash && !new URLSearchParams(location.search).has("token"), null, { timeout: 15_000 });
    phase = "profile-persistence";
    navigationTrace.setPhase(phase);
    await page.waitForFunction(({ publicBaseUrl }) => {
      try {
        const raw = localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2");
        const index = raw ? JSON.parse(raw) : null;
        return Array.isArray(index?.profiles) && index.profiles.some(profile => profile.baseUrl === publicBaseUrl);
      } catch { return false; }
    }, { publicBaseUrl: lane.publicBaseUrl }, { timeout: 30_000 });
    const freshIds = await readDeviceIdentities(page, lane.publicBaseUrl).then(ids => ids.filter(id => !priorIds.includes(id)));
    assert.equal(freshIds.length, 1, "pairing must create exactly one new device identity; existing identities are never benchmark cleanup targets");
    cleanupCandidates.set(lane.publicBaseUrl, freshIds[0]);
    const elapsedMs = performance.now() - started;
    navigationTrace.setPhase("paired");
    return {
      status: "paired",
      elapsedMs: Number(elapsedMs.toFixed(3)),
      bootstrapTcpPeer: { ipAddress: bootstrapServerAddress.ipAddress, port: bootstrapServerAddress.port },
      navigationTcpPeer: { ipAddress: serverAddress.ipAddress, port: serverAddress.port },
      boundary: "strict-TLS page navigation and actual TCP peer verification through token scrub and persistence of one freshly created Mobile identity",
    };
  } catch (error) {
    const freshIds = await readDeviceIdentities(page, lane.publicBaseUrl).then(ids => ids.filter(id => !priorIds.includes(id))).catch(() => []);
    if (freshIds.length === 1) cleanupCandidates.set(lane.publicBaseUrl, freshIds[0]);
    navigationTrace.setPhase(`failed:${phase}`);
    throw safePairingDiagnostic(phase, error);
  }
}

function createNavigationTrace(page) {
  const startedAt = performance.now();
  const events = [];
  const criticalScriptRequests = new Set();
  const criticalScriptFailures = [];
  const requestResource = new WeakMap();
  let phase = "before-navigation";

  const record = (event, resource, details = {}) => {
    if (events.length >= 120) return;
    events.push({
      atUtc: new Date().toISOString(),
      elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
      phase,
      event,
      resource,
      ...details,
    });
  };

  page.on("request", request => {
    const resource = classifyNavigationResource(request);
    if (!resource) return;
    requestResource.set(request, resource);
    if (resource === "mobile-entry-script" || resource === "mobile-crypto-script") criticalScriptRequests.add(request);
    record("request", resource);
  });
  page.on("response", response => {
    const request = response.request();
    const resource = requestResource.get(request) || classifyNavigationResource(request);
    if (!resource) return;
    record("response", resource, { status: response.status() });
  });
  page.on("requestfinished", request => {
    const resource = requestResource.get(request);
    if (!resource) return;
    criticalScriptRequests.delete(request);
    record("finished", resource);
  });
  page.on("requestfailed", request => {
    const resource = requestResource.get(request) || classifyNavigationResource(request);
    if (!resource) return;
    criticalScriptRequests.delete(request);
    const failureCode = safeNetworkFailureCode(request.failure()?.errorText);
    record("requestfailed", resource, { failureCode });
    if (resource === "mobile-entry-script" || resource === "mobile-crypto-script") criticalScriptFailures.push({ resource, failureCode });
  });

  return {
    events,
    get currentPhase() {
      return phase;
    },
    setPhase(nextPhase) {
      phase = nextPhase;
      record("phase-start", nextPhase);
    },
    recordNavigation(name, status, serverAddress) {
      record("navigation-response", name, {
        status,
        tcpPeer: { ipAddress: serverAddress.ipAddress, port: serverAddress.port },
      });
    },
    markReadyControl() {
      record("react-connect-ready", "pairing-retry-control", { visible: true, enabled: true });
    },
    async waitForCriticalScripts(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let quietSince;
      while (Date.now() < deadline) {
        if (criticalScriptFailures.length) {
          const failure = criticalScriptFailures[0];
          throw new Error(`${failure.resource}:${failure.failureCode}`);
        }
        if (criticalScriptRequests.size === 0) {
          quietSince ??= Date.now();
          if (Date.now() - quietSince >= 500) return;
        } else {
          quietSince = undefined;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (criticalScriptRequests.size) throw new Error("critical-mobile-script-settle-timeout");
    },
  };
}

function classifyNavigationResource(request) {
  if (request.isNavigationRequest()) return "mobile-document";
  if (request.resourceType() !== "script") return null;
  let pathname;
  try {
    pathname = new URL(request.url()).pathname;
  } catch {
    return "script";
  }
  if (/\/_expo\/static\/js\/web\/index-[A-Za-z0-9_-]+\.js$/i.test(pathname)) return "mobile-entry-script";
  if (/\/_expo\/static\/js\/web\/Crypto-[A-Za-z0-9_-]+\.js$/i.test(pathname)) return "mobile-crypto-script";
  return "script";
}

function safePairingDiagnostic(phase, error) {
  const message = error instanceof Error ? error.message : String(error);
  const networkFailure = message.match(/net::ERR_[A-Z0-9_]{1,64}/i)?.[0];
  const reason = networkFailure || (/Timeout \d+ms exceeded/i.test(message) ? "timeout" : safeErrorName(error));
  return new Error(`${phase}: ${reason}`);
}

async function readDeviceIdentities(page, publicBaseUrl) {
  return await page.evaluate(async baseUrl => {
    const list = window.__listMobilePeerRouteBenchmarkDeviceIdentities;
    if (typeof list !== "function") throw new Error("Mobile benchmark identity inspector is unavailable");
    return await list(baseUrl);
  }, publicBaseUrl);
}

async function measureLane(page, lane, mode, fixture) {
  return await page.evaluate(async input => {
    const runner = window.__runMobilePeerRouteBenchmark;
    if (typeof runner !== "function") throw new Error("Mobile route benchmark bundle did not initialize");
    return await runner(input);
  }, browserRunConfig(lane, mode, fixture));
}

async function revokeDevice(page, publicBaseUrl, expectedDeviceId, cleanupNetworkObservations) {
  const observationStart = cleanupNetworkObservations.length;
  let result;
  let clientFailureName;
  try {
    result = await page.evaluate(async ({ baseUrl, expectedDeviceId }) => {
      const revoke = window.__revokeMobilePeerRouteBenchmarkDevice;
      if (typeof revoke !== "function") return { attempted: false, status: "benchmark-bundle-unavailable" };
      return await revoke(baseUrl, expectedDeviceId);
    }, { baseUrl: publicBaseUrl, expectedDeviceId });
  } catch (error) {
    clientFailureName = safeErrorName(error);
    result = { attempted: true, status: "unknown-after-single-delete-attempt", retry: false };
  }
  const httpObservations = cleanupNetworkObservations.slice(observationStart);
  return { ...result, expectedEndpoint: safeUrl(publicBaseUrl), ...(clientFailureName ? { clientFailureName } : {}), httpObservations };
}

async function cleanupDeviceOnce(page, publicBaseUrl, cleanupCandidates, attemptedBaseUrls, cleanupNetworkObservations) {
  if (attemptedBaseUrls.has(publicBaseUrl)) return { attempted: false, status: "already-attempted", retry: false };
  const expectedDeviceId = cleanupCandidates.get(publicBaseUrl);
  if (!expectedDeviceId) return { attempted: false, status: "no-owned-fresh-device", retry: false };
  // Mark before dispatch so an uncertain DELETE result can never trigger a second attempt.
  attemptedBaseUrls.add(publicBaseUrl);
  return await revokeDevice(page, publicBaseUrl, expectedDeviceId, cleanupNetworkObservations).catch(() => ({ attempted: false, status: "cleanup-unavailable", retry: false }));
}

async function captureLaneFailure(context, laneName, operation) {
  try {
    return await operation();
  } catch (error) {
    return {
      mode: laneName,
      status: "failed",
      failure: safeFailure(context, error),
      quality: { measurementComplete: false },
    };
  }
}

function safeFailure(context, error) {
  return context.redactText(error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/kcoder-p2p:\/\/[a-f0-9]{48}/gi, "kcoder-p2p://<session>")
    .slice(0, 500);
}

function browserRunConfig(lane, mode, fixture) {
  return {
    mode,
    publicBaseUrl: lane.publicBaseUrl,
    expectedConnectionRoutes: lane.connectionRoutes,
    expectedGatewayIps: lane.expectedGatewayIps,
    expectedClientIps: lane.expectedClientIps,
    expectedStunUrl: lane.stunUrl,
    fixture: {
      threadId: fixture.threadId,
      attachmentPath: fixture.attachmentPath,
      size: fixture.size,
      sha256: fixture.sha256,
      chunkBytes: fixture.chunkBytes,
      repetitions: fixture.repetitions,
    },
    rttSamples: 30,
    timeoutMs: 2_000,
    attachmentTimeoutMs: ATTACHMENT_TIMEOUT_MS,
  };
}

function makePairingUrl(lane) {
  const url = new URL(lane.mobileConnectUrl);
  url.searchParams.set("gateway", lane.publicBaseUrl);
  url.searchParams.set("routes", JSON.stringify(lane.connectionRoutes));
  url.hash = new URLSearchParams({ token: lane.pairingToken }).toString();
  return url.toString();
}

function safeUrl(value) {
  const url = new URL(value);
  return { protocol: url.protocol, hostname: url.hostname, port: url.port || null, pathname: redactGatewayMount(url.pathname) };
}

function safeIdentityDeleteEndpoint(value, method) {
  if (method !== "DELETE") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const match = url.pathname.match(/^(.*\/api\/mobile\/devices\/)[A-Za-z0-9-]{16,128}$/);
    if (!match) return null;
    const path = `${match[1].replace(/\/g\/[A-Za-z0-9_-]{1,64}(?=\/)/, "/g/:id")}:id`;
    return { origin: url.origin, protocol: url.protocol, hostname: url.hostname, port: url.port || null, path };
  } catch {
    return null;
  }
}

function safeNetworkFailureCode(value) {
  if (typeof value !== "string") return "unknown-network-failure";
  return /^net::ERR_[A-Z0-9_]{1,64}$/.test(value) ? value : "request-failed";
}

function safeErrorName(error) {
  const name = error instanceof Error ? error.name : "Error";
  return /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name) ? name : "Error";
}

function redactGatewayMount(pathname) {
  return pathname.replace(/^(\/g\/)[A-Za-z0-9_-]+(?=\/|$)/, "$1:id");
}

function safeMobileWebExport(value) {
  const keys = ["sourceTreeSha256", "bundleSha256", "manifestSha256", "manifestFileCount"];
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

async function readPrivateConfig(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > 128 * 1024) {
    throw new Error("Private benchmark config must be a single-link 0600-or-stricter file under 128 KiB");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Private benchmark config must belong to the runner user");
  return JSON.parse(await readFile(path, "utf8"));
}

function validateConfig(value) {
  assert.equal(value?.schemaVersion, 1, "unsupported benchmark config schema");
  assert.deepEqual(Object.keys(value).sort(), [...CONFIG_KEYS].sort(), "benchmark config has unknown or missing fields");
  assert.ok(value.browser && typeof value.browser.executablePath === "string");
  assert.deepEqual(Object.keys(value.browser).sort(), value.browser.caTrust ? ["caTrust", "executablePath"] : ["executablePath"]);
  if (value.browser.caTrust) {
    assert.deepEqual(Object.keys(value.browser.caTrust).sort(), ["certificatePath", "certificateSha256", "nickname"].sort());
    assert.ok(typeof value.browser.caTrust.certificatePath === "string" && /^[a-f0-9]{64}$/.test(value.browser.caTrust.certificateSha256));
    assert.ok(/^[A-Za-z0-9._-]{1,64}$/.test(value.browser.caTrust.nickname));
  }
  assert.ok(value.bundle && typeof value.bundle.path === "string" && /^[a-f0-9]{64}$/.test(value.bundle.sha256));
  assert.deepEqual(Object.keys(value.bundle).sort(), ["entrySourceSha256", "mobileSourceTreeSha256", "path", "sha256", "sharedSourceTreeSha256"].sort());
  for (const field of ["entrySourceSha256", "mobileSourceTreeSha256", "sharedSourceTreeSha256"]) {
    assert.ok(/^[a-f0-9]{64}$/.test(value.bundle[field]), `bundle.${field} must be a SHA-256 pin`);
  }
  assert.ok(value.fixture && typeof value.fixture.threadId === "string" && value.fixture.threadId.length <= 128);
  assert.deepEqual(Object.keys(value.fixture).sort(), ["attachmentPath", "chunkBytes", "repetitions", "sha256", "size", "threadId"].sort());
  assert.equal(value.fixture.size, 1024 * 1024);
  assert.equal(value.fixture.chunkBytes, 512 * 1024);
  assert.equal(value.fixture.repetitions, 3);
  assert.equal(value.fixture.attachmentPath, "/peer-route/fixture-payload-1m.bin", "fixture attachment path must be the fixed synthetic fixture path");
  assert.ok(/^[a-f0-9]{64}$/.test(value.fixture.sha256));
  for (const [name, lane] of [["lan", value.lan], ["public", value.public]]) {
    assert.ok(lane && typeof lane === "object");
    const expectedLaneKeys = ["mobileConnectUrl", "publicBaseUrl", "pairingToken", "connectionRoutes", "expectedGatewayIps", "expectedClientIps", ...(name === "public" ? ["stunUrl"] : [])];
    assert.deepEqual(Object.keys(lane).sort(), expectedLaneKeys.sort(), `${name} lane has unknown or missing fields`);
    assert.ok(lane && typeof lane.mobileConnectUrl === "string");
    assert.ok(typeof lane.publicBaseUrl === "string" && typeof lane.pairingToken === "string");
    assert.ok(typeof lane.pairingToken === "string" && lane.pairingToken.length >= 16 && lane.pairingToken.length <= 512);
    const routes = parseGatewayConnectionRoutes(lane.connectionRoutes);
    assert.ok(routes, `${name}.connectionRoutes must satisfy the signed Gateway descriptor wire schema`);
    assert.ok(Array.isArray(lane.expectedGatewayIps) && lane.expectedGatewayIps.length > 0 && lane.expectedGatewayIps.every(value => isIP(value) > 0));
    assert.ok(Array.isArray(lane.expectedClientIps) && lane.expectedClientIps.length > 0 && lane.expectedClientIps.every(value => isIP(value) > 0));
    const connect = new URL(lane.mobileConnectUrl);
    assert.equal(connect.protocol, "https:", "real Mobile Web pairing must run in a trusted HTTPS context");
    assert.ok(connect.pathname.endsWith("/mobile/connect"), "mobileConnectUrl must point at the actual Gateway-hosted Mobile connect route");
    assert.equal(connect.search, "", "mobileConnectUrl must not include query credentials");
    assert.equal(connect.hash, "", "mobileConnectUrl must not include fragment credentials");
    assert.ok(typeof connect.hostname === "string" && !isLoopbackGatewayConnectionUrl(connect.origin), `${name}.mobileConnectUrl cannot use loopback`);
    const base = new URL(lane.publicBaseUrl);
    assert.equal(base.protocol, "https:", `${name}.publicBaseUrl must be strict HTTPS`);
    assert.equal(base.username, "");
    assert.equal(base.password, "");
    assert.equal(base.search, "");
    assert.equal(base.hash, "");
    assert.ok(!isLoopbackGatewayConnectionUrl(lane.publicBaseUrl), `${name}.publicBaseUrl cannot use loopback`);
    if (name === "public") {
      assert.equal(base.origin, EXPECTED_PUBLIC_RELAY_ORIGIN, "public route must use the owned Aliyun Relay origin");
      assert.ok(!isPrivateAddress(base.hostname), "public Gateway entry must not use a local/private IP or hostname");
      assert.ok(/^\/g\/[A-Za-z0-9_-]{1,64}$/.test(base.pathname), "public Gateway base must use the exact scoped /g/<id> mount");
    }
    assert.ok(routes.endpoints.some(endpoint => endpoint.url === lane.publicBaseUrl), `${name}.publicBaseUrl must be one of the server-signed route endpoints`);
    const requiredEndpointKind = name === "lan" ? "lan" : "public";
    assert.ok(routes.endpoints.some(endpoint => endpoint.kind === requiredEndpointKind),
      `${name}.connectionRoutes must contain its own Gateway's signed ${requiredEndpointKind} endpoint`);
    if (name === "lan") assert.ok(lane.expectedGatewayIps.includes(connect.hostname), "LAN Mobile page must use the expected A4500 Gateway address");
  }
  assert.equal(value.public.stunUrl, "stun:47.80.92.250:8452");
  assert.deepEqual(Object.keys(value.mobileWebExport).sort(), ["bundleSha256", "manifestFileCount", "manifestSha256", "sourceTreeSha256"].sort());
  assert.ok(/^[a-f0-9]{64}$/.test(value.mobileWebExport.sourceTreeSha256));
  assert.ok(/^[a-f0-9]{64}$/.test(value.mobileWebExport.bundleSha256));
  assert.ok(/^[a-f0-9]{64}$/.test(value.mobileWebExport.manifestSha256));
  assert.ok(Number.isSafeInteger(value.mobileWebExport.manifestFileCount) && value.mobileWebExport.manifestFileCount > 0);
  assert.deepEqual(value.lan.expectedGatewayIps, [EXPECTED_LAN_GATEWAY_IP], "LAN Gateway address must identify the owned A4500 host");
  assert.deepEqual(value.public.expectedGatewayIps, ["107.173.236.155"], "public ICE Gateway address must identify vps_first");
  if (!PUBLIC_GET_ONLY) {
    assert.deepEqual(value.lan.expectedClientIps, ["10.31.6.8"], "LAN client address must identify H20's A4500 route source");
    assert.deepEqual(value.public.expectedClientIps,
      PUBLIC_BENCHMARK_ONLY ? ["10.31.7.10", "175.0.133.87"] : ["10.31.6.23", "175.0.133.87"],
      PUBLIC_BENCHMARK_ONLY ? "public ICE client address must match this workstation's verified route source or fresh STUN mapping" : "public ICE client address must identify H20's VPS route source or fresh STUN mapping");
  }
  assert.equal(value.bundle.mobileSourceTreeSha256, value.mobileWebExport.sourceTreeSha256);
}

function isPrivateAddress(hostname) {
  if (isIP(hostname) === 0) return /(^|\.)(localhost|local|lan|internal)$/.test(hostname.toLowerCase());
  if (isIP(hostname) === 4) {
    const [a, b] = hostname.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const value = hostname.toLowerCase();
  return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
    /^fe[89ab]/.test(value) || value.startsWith("::ffff:127.") || value.startsWith("::ffff:10.");
}
