import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMobileLatencyHelpers } from "../harness/mobile-latency-helpers.mjs";
import { copyOfficialMobileStaticDist } from "../harness/mobile-static-dist-input.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { materializeWorkspace } from "../harness/workspace-fixture.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { loadOwnedProductionRelayIdentity } from "./production-relay-registration-key.once.mjs";

// After Root review, run with the pinned Node 22 executable and an owned Chromium profile:
// timeout --signal=INT --kill-after=120s 300s env \
//   KCODER_E2E_PUBLIC_HOSTED_PRODUCTION_RELAY_ONCE=1 KCODER_E2E_CHROMIUM_NO_SANDBOX=1 \
//   /home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node \
//   apps/kcoder-studio/e2e/private/mobile-gateway-hosted-production-relay.once.e2e.mjs
const RUN_FLAG = "KCODER_E2E_PUBLIC_HOSTED_PRODUCTION_RELAY_ONCE";
const EXPECTED_NODE = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const PUBLIC_ORIGIN = "https://hyf2333.top:8451";
const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host;
const MAIN_REPO_ROOT = resolve(repoRoot, "..", "..");
const RELAY_CLIENT_FILES = Object.freeze({
  "apps/kcoder-relay/src/client.mjs": "339d7d85a203d2a6293138c000d0a17aa6bb0de1ae40bb9e524aae0073d988f8",
  "apps/kcoder-relay/src/transport.mjs": "6a56287394425ce297a2c87534c739645cd85eb99efc707ffe9d1ce6a8277d7c",
  "apps/kcoder-relay/src/config.mjs": "b24e5c93198e0b5e0d9478785d5be8ecb826bb69479ac3a4a04a09acdd762335",
  "apps/kcoder-relay/src/client-identity.mjs": "c9e22731e4b553b1060f5dc4060de5ff4f37483527ade1a28104741c2500aa7d",
});
const WS_RUNTIME_PIN = Object.freeze({
  version: "8.22.0",
  packageTreeSha256: "3271cba667fdc4721ed9fe275eae78247d07ded06cddd52b824359880aeb4c1d",
});
const GATEWAY_SNAPSHOT = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/private/mobile-sessions-current-dist-touch-control.once.e2e.mjs/20261009-155611.082Z/artifacts/gateway-runtime-frozen");
const GATEWAY_PINS = Object.freeze({
  manifestSha256: "5c0f95fefa51cb7180e832d4896f29c320e3887a214a5e265a452ec38be3f171",
  sourceTreeSha256: "373ba06a96f30e1ce8df651560bf826d0b48bb618159ba353c0629a34dbc8c1c",
  dependencyTreeSha256: "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954",
});
const MOBILE_DIST = resolve(repoRoot, "target/worktree/2026/10/09/mobile-ux-all-changes-20261009/apps/kcoder-studio/mobile/dist");
const MOBILE_DIST_MANIFEST_SHA256 = "5053ac22d3476f7f17513a3c76a71b8993f3752e47bd060b8bead5c07c830752";
const SERVER_ID = "public-smoke";
const OWNED_IDENTITY_FINGERPRINT = "d082cb3f4ecdcf4e";

assert.equal(process.env[RUN_FLAG], "1", `${RUN_FLAG}=1 is required for this private public-service smoke`);
assert.equal(process.execPath, EXPECTED_NODE, "use the reviewed Node 22.17.0 executable");
assert.equal(process.version, "v22.17.0", "use the reviewed Node 22.17.0 runtime");
assert.equal(process.argv.length, 2, "the once runner accepts no extra arguments");

await runE2E(import.meta.url, {
  testId: "mobile-gateway-hosted-production-relay-once",
  tier: "manual-live",
  retainSuccessLogs: true, bodyAbortTimeoutMs: 10_000, cleanupTimeoutMs: 90_000,
  modelPolicy: "one public HTTPS Mobile Web static load and UI pairing/Home/New navigation through the production Relay into an isolated KCODER_STUDIO_MOCK Gateway; no Provider, model turn, phone/native, RTT, or performance claim",
}, async context => {
  const evidence = { state: "running", stage: "input-validation", overallAuthority: "RunContext result.json/manifest", origin: { scheme: "https", host: PUBLIC_HOST }, runtime: {}, mobileDist: {},
    registration: { connectionOwnedByRun: true, connectionOwnerRunId: null, readOnlyExistingIdentityRecovery: false,
      attemptStarted: false, registerPostAttempts: 0, registerPostStatus: null, registrationCountDelta: null,
      created: false, persistentRegistrationRemains: null, persistentRegistrationState: "unknown", reusableOwnedIdentity: false,
      identityFingerprint: null, identityStoredInOwnedState: true, localCredentialStateRemovedByRunContext: true, maximumCreationsByThisRun: 0 },
    entry: { nodeFetchStatus: null, nodeMetadataValid: false, browserApiStatus: null, browserApiRequestCount: 0,
      browserApiFailureClass: null, browserMetadataValid: false, available: null, exactCredentialFreeEndpoints: null },
    browser: { outsideHostRequests: 0, websocketConnectionsCreated: 0, websocketConnectionsWithFrames: 0, websocketFramesSent: 0, websocketFramesReceived: 0, websocketConnectionsClosed: 0 },
    pairing: { postObserved: false, status: null, tokenValueRecorded: false },
    ui: { welcomeVisible: false, homeOnlineVisible: false, newOpened: false, modelActionTriggered: false },
    assets: [], assetCaptureErrors: 0, gateway: { mock: true, providerCall: false },
    failureDetails: null,
    claims: { physicalPhone: false, nativeRuntime: false, rttOrPerformance: false, liveFullBackendSourceSnapshot: false } };
  context.addCleanup("write safe public hosted smoke evidence", async () => {
    if (evidence.state === "running") evidence.state = "incomplete";
    await context.writeArtifactJsonInternal("public-hosted-production-relay-smoke.json", evidence);
  });

  try {
    const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
    const mobileHelpers = createMobileLatencyHelpers({ sha256 });
    const gatewayRuntime = await mobileHelpers.prepareGatewayRuntimeSnapshot(context, GATEWAY_SNAPSHOT);
    assert.equal(gatewayRuntime.manifestSha256, GATEWAY_PINS.manifestSha256);
    assert.equal(gatewayRuntime.manifest.sourceTreeSha256, GATEWAY_PINS.sourceTreeSha256);
    assert.equal(gatewayRuntime.manifest.dependencyTreeSha256, GATEWAY_PINS.dependencyTreeSha256);
    assert.equal(gatewayRuntime.manifest.status, "complete");
    assert.equal(gatewayRuntime.manifest.nodeVersion, "v22.17.0");
    evidence.runtime = { manifestSha256: gatewayRuntime.manifestSha256, sourceTreeSha256: gatewayRuntime.manifest.sourceTreeSha256,
      dependencyTreeSha256: gatewayRuntime.manifest.dependencyTreeSha256, basis: "fixed Gateway runtime snapshot; KCODER_STUDIO_MOCK=1; no binary or live full-backend source claim" };

    const mobileDist = await copyOfficialMobileStaticDist(context, { distRoot: MOBILE_DIST,
      expectedManifestSha256: MOBILE_DIST_MANIFEST_SHA256, outputName: "official-mobile-web-dist" });
    assert.equal(mobileDist.resourceCount, 37);
    const entryScripts = mobileDist.resources.filter(row => /^_expo\/static\/js\/web\/entry-[a-f0-9]+\.js$/.test(row.path));
    assert.equal(entryScripts.length, 1, "official Mobile dist has one pinned web entry bundle");
    const builtEntry = await readFile(join(mobileDist.ownedRoot, entryScripts[0].path), "utf8");
    for (const selector of ["welcome-direct-connection", "gateway-endpoint", "gateway-token", "gateway-connect", "new-workspace-", "workspace-path", "model-selector", "online"]) {
      assert.ok(builtEntry.includes(selector), `official Mobile dist entry bundle must contain ${selector}`);
    }
    evidence.mobileDist = { manifestSha256: mobileDist.manifestSha256, resourceCount: mobileDist.resourceCount,
      totalResourceBytes: mobileDist.totalResourceBytes, declaredFontResources: mobileDist.resources.filter(row => /\.(?:woff2?|ttf|otf)$/i.test(row.path)).length,
      entryBundleSha256: entryScripts[0].sha256, requiredUiSelectorsPresent: true };

    const relayInputsBefore = await verifyRelayClientInputs(sha256);
    evidence.runtime.relayClientSourceClosureSha256 = relayInputsBefore.sourceClosureSha256;
    evidence.runtime.wsDependency = { version: relayInputsBefore.wsVersion, packageTreeSha256: relayInputsBefore.wsPackageTreeSha256 };

    evidence.stage = "recover-owned-production-relay-identity";
    const recoveredIdentity = await loadOwnedProductionRelayIdentity(context, { expectedIdFingerprint: OWNED_IDENTITY_FINGERPRINT });
    const pairingToken = recoveredIdentity.pairingToken;
    const identityFingerprint = sha256(Buffer.from(recoveredIdentity.id)).slice(0, 16);
    assert.equal(identityFingerprint, OWNED_IDENTITY_FINGERPRINT);
    const identityFile = await context.writeStateJson("relay-registration/identity.json", {
      version: 1,
      relayOrigin: PUBLIC_ORIGIN,
      pairingTokenHash: sha256(Buffer.from(pairingToken)),
      id: recoveredIdentity.id,
      secret: recoveredIdentity.secret,
    });
    const identityInfo = await lstat(identityFile);
    const identityDirectoryInfo = await lstat(dirname(identityFile));
    assert.ok(identityInfo.isFile() && !identityInfo.isSymbolicLink() && identityDirectoryInfo.isDirectory() && !identityDirectoryInfo.isSymbolicLink());
    assert.equal(identityInfo.uid, process.getuid());
    assert.equal(identityInfo.mode & 0o777, 0o600, "Relay identity file stays private");
    assert.equal(identityDirectoryInfo.mode & 0o777, 0o700, "Relay identity directory stays private");
    const identityRecord = JSON.parse(await readFile(identityFile, "utf8"));
    assert.deepEqual(Object.keys(identityRecord).sort(), ["id", "pairingTokenHash", "relayOrigin", "secret", "version"]);
    assert.equal(identityRecord.version, 1);
    assert.equal(identityRecord.relayOrigin, PUBLIC_ORIGIN);
    assert.equal(identityRecord.pairingTokenHash, sha256(Buffer.from(pairingToken)));
    assert.equal(identityRecord.id, recoveredIdentity.id);
    assert.equal(identityRecord.secret, recoveredIdentity.secret);
    evidence.registration = { ...evidence.registration,
      connectionOwnerRunId: relative(resolve(repoRoot, "target/test/apps/kcoder-studio/e2e"), context.runRoot),
      readOnlyExistingIdentityRecovery: true,
      registerPostAttempts: 0,
      registrationCountDelta: 0,
      created: false,
      persistentRegistrationRemains: true,
      persistentRegistrationState: "reused-existing",
      reusableOwnedIdentity: false,
      identityFingerprint,
      identityStoredInOwnedState: true,
      maximumCreationsByThisRun: 0 };

    evidence.stage = "owned-gateway-startup";
    const workspace = await materializeWorkspace(context, "minimal", { instanceId: "public-hosted-mobile-smoke" });
    const serversFile = await context.writeStateJson("servers.json", [{ id: SERVER_ID, label: "Public smoke", runtime: "kcoder",
      transport: "local", command: process.execPath, workspace: workspace.path }]);
    const gatewayHome = context.pathInState("gateway-home");
    const configDir = context.pathInState("gateway-config");
    await Promise.all([mkdir(gatewayHome, { recursive: true, mode: 0o700 }), mkdir(configDir, { recursive: true, mode: 0o700 })]);
    const gateway = await startGateway(context, { label: "public-hosted-mobile-smoke-gateway", auth: true, authToken: pairingToken,
      gatewayRoot: gatewayRuntime.root, cwd: gatewayRuntime.root, workspace: workspace.path, serversFile,
      serversStore: context.pathInState("servers-store.json"), kcoderBin: process.execPath,
      env: { KCODER_STUDIO_MOCK: "1", KCODER_STUDIO_WEB_ROOT: "", KCODER_STUDIO_MOBILE_WEB_ROOT: mobileDist.ownedRoot,
        KCODER_STUDIO_PUBLIC_ORIGINS: PUBLIC_ORIGIN, KCODER_STUDIO_MOBILE_WEB_ORIGINS: PUBLIC_ORIGIN,
        KCODER_STUDIO_SECURE_COOKIE: "1", KCODER_CONFIG_DIR: configDir, KCODER_HOME: gatewayHome } });

    evidence.stage = "reuse-owned-production-relay-identity";
    let relayOnline = false;
    const relayModule = await import(pathToFileURL(resolve(MAIN_REPO_ROOT, "apps/kcoder-relay/src/client.mjs")).href);
    let unexpectedRegistrationFetchCalls = 0;
    const rejectRegistrationFetch = async () => {
      unexpectedRegistrationFetchCalls += 1;
      evidence.registration.registerPostAttempts = unexpectedRegistrationFetchCalls;
      throw new Error("cached Relay identity unexpectedly attempted registration");
    };
    const relayClient = await relayModule.startRegisteredClient({ url: PUBLIC_ORIGIN, pairingToken,
      identityFile, gateway: gateway.baseUrl, retryMs: 500, onOnline: () => { relayOnline = true; }, fetchImpl: rejectRegistrationFetch });
    context.addCleanup("close owned production Relay client", async () => {
      relayClient.close();
      evidence.registration.clientCloseRequestedByRunCleanup = true;
    });
    assert.equal(unexpectedRegistrationFetchCalls, 0, "cached identity must skip Relay registration fetch");
    assert.equal(evidence.registration.registerPostAttempts, 0);
    assert.equal(evidence.registration.registrationCountDelta, 0);
    assert.equal(evidence.registration.persistentRegistrationRemains, true);
    await waitFor(() => relayOnline, 30_000, "owned Gateway control channel online through the production Relay", 50, context.abortSignal);
    evidence.registration.controlChannelOnline = true;
    evidence.stage = "public-browser";

    const mount = `/g/${recoveredIdentity.id}/mobile`;
    const entryPath = `/g/${recoveredIdentity.id}/mobile-entry`;
    const gatewayBase = `${PUBLIC_ORIGIN}/g/${recoveredIdentity.id}`;
    const mobileUrl = `${PUBLIC_ORIGIN}${mount}/`;
    const pairingPath = `/g/${recoveredIdentity.id}/api/mobile/session`;
    let nodeEntry;
    try {
      const response = await fetch(`${PUBLIC_ORIGIN}${entryPath}`, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      evidence.entry.nodeFetchStatus = response.status;
      if (response.status !== 200) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error("mobile-entry metadata returned a non-200 status");
      }
      nodeEntry = await response.json();
    } catch (error) {
      evidence.entry.nodeFetchFailureClass = safeNodeFetchFailure(error);
      throw new Error("credential-free mobile-entry metadata GET failed");
    }
    const nodeEntryValidation = validateMobileEntry(nodeEntry, { mobileUrl, gatewayBase, pairingToken, relaySecret: recoveredIdentity.secret });
    evidence.entry.nodeMetadataValid = nodeEntryValidation.valid;
    evidence.entry.available = nodeEntryValidation.available;
    evidence.entry.exactCredentialFreeEndpoints = nodeEntryValidation.valid;
    assert.equal(nodeEntryValidation.valid, true, "Node GET returned the exact credential-free mobile-entry schema and URLs");

    const chromium = await startChromium(context, { label: "public-hosted-mobile-smoke-chromium", noSandbox: true });
    const page = await chromium.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const assetTasks = [];
    page.on("request", request => {
      try {
        const url = new URL(request.url());
        if (url.host !== PUBLIC_HOST || !["https:", "wss:"].includes(url.protocol)) evidence.browser.outsideHostRequests += 1;
        if (url.host === PUBLIC_HOST && url.pathname === pairingPath && request.method() === "POST") evidence.pairing.postObserved = true;
        if (url.origin === PUBLIC_ORIGIN && url.pathname === entryPath && request.method() === "GET" && !url.search && !url.hash) evidence.entry.browserApiRequestCount += 1;
      } catch { evidence.browser.outsideHostRequests += 1; }
    });
    page.on("requestfailed", request => {
      try {
        const url = new URL(request.url());
        if (request.method() !== "GET" || url.origin !== PUBLIC_ORIGIN || url.pathname !== entryPath || url.search || url.hash) return;
        const errorText = request.failure()?.errorText;
        evidence.entry.browserApiFailureClass = errorText === "net::ERR_NETWORK_CHANGED" ? "ERR_NETWORK_CHANGED" : "other";
      } catch { /* Do not persist raw request URLs or failure text. */ }
    });
    page.on("websocket", socket => {
      let url;
      try { url = new URL(socket.url()); } catch { return; }
      if (url.protocol !== "wss:" || url.host !== PUBLIC_HOST) return;
      evidence.browser.websocketConnectionsCreated += 1;
      let observedFrame = false;
      const observeFrame = direction => {
        evidence.browser[direction] += 1;
        if (!observedFrame) { observedFrame = true; evidence.browser.websocketConnectionsWithFrames += 1; }
      };
      socket.on("framesent", () => observeFrame("websocketFramesSent"));
      socket.on("framereceived", () => observeFrame("websocketFramesReceived"));
      socket.on("close", () => { evidence.browser.websocketConnectionsClosed += 1; });
    });
    page.on("response", response => {
      try {
        const url = new URL(response.url());
        if (url.origin !== PUBLIC_ORIGIN || !(url.pathname === `${mount}/` || url.pathname.startsWith(`${mount}/`))) return;
        if (evidence.assets.length + assetTasks.length >= 96) return;
        const request = response.request();
        const kind = assetKind(url.pathname, request.resourceType());
        const task = captureAsset(response, kind).then(row => { if (row) evidence.assets.push(row); }).catch(() => { evidence.assetCaptureErrors += 1; });
        assetTasks.push(task);
      } catch { evidence.assetCaptureErrors += 1; }
    });
    page.on("response", response => {
      try {
        const url = new URL(response.url());
        if (url.origin === PUBLIC_ORIGIN && url.pathname === entryPath && !url.search && !url.hash) evidence.entry.browserApiStatus = response.status();
        if (url.origin === PUBLIC_ORIGIN && url.pathname === pairingPath && response.request().method() === "POST") evidence.pairing.status = response.status();
      } catch { /* The safe evidence record omits malformed response URLs. */ }
    });

    const documentResponse = await page.goto(mobileUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert.equal(documentResponse?.status(), 200, "official Mobile Web document loads from the production Relay/Gateway route");
    const browserEntry = await page.evaluate(async path => {
      try {
        const response = await fetch(path, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store" });
        let payload;
        try { payload = await response.json(); }
        catch { return { status: response.status, jsonValid: false, payload: null }; }
        return { status: response.status, jsonValid: true, payload };
      } catch {
        return { status: null, jsonValid: false, payload: null };
      }
    }, entryPath);
    evidence.entry.browserApiStatus ??= browserEntry.status;
    const browserEntryValidation = browserEntry.jsonValid
      ? validateMobileEntry(browserEntry.payload, { mobileUrl, gatewayBase, pairingToken, relaySecret: recoveredIdentity.secret })
      : { valid: false, available: false };
    evidence.entry.browserMetadataValid = browserEntryValidation.valid;
    evidence.entry.available = evidence.entry.available && browserEntryValidation.available;
    evidence.entry.exactCredentialFreeEndpoints = evidence.entry.exactCredentialFreeEndpoints && browserEntryValidation.valid;
    assert.equal(evidence.entry.browserApiStatus, 200, "same-origin Mobile Web fetch receives mobile-entry HTTP 200");
    assert.equal(evidence.entry.browserApiRequestCount, 1, "Mobile Web issued one exact credential-free mobile-entry GET");
    assert.equal(browserEntryValidation.valid, true, "Browser GET returned the exact credential-free mobile-entry schema and URLs");

    const welcome = page.getByTestId("welcome-direct-connection");
    await welcome.waitFor({ state: "visible", timeout: 30_000 });
    evidence.ui.welcomeVisible = true;
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await welcome.click();
    await page.getByTestId("gateway-endpoint").fill(gatewayBase);
    await page.getByTestId("gateway-token").fill(pairingToken);
    const pairResponsePromise = page.waitForResponse(response => {
      try { const url = new URL(response.url()); return url.origin === PUBLIC_ORIGIN && url.pathname === pairingPath && response.request().method() === "POST"; }
      catch { return false; }
    }, { timeout: 30_000 });
    await page.getByTestId("gateway-connect").click();
    assert.equal((await pairResponsePromise).status(), 200, "pairing submitted from the hosted Mobile Web UI succeeds");
    await page.waitForURL(/\/h\/[^/?#]+(?:\/|$)/, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[aria-label="online"]') !== null, undefined, { timeout: 30_000 });
    evidence.ui.homeOnlineVisible = true;
    const newButton = page.getByTestId(`new-workspace-${SERVER_ID}`);
    await newButton.waitFor({ state: "visible", timeout: 30_000 });
    await newButton.click();
    await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("model-selector").waitFor({ state: "visible", timeout: 30_000 });
    evidence.ui.newOpened = true;
    await Promise.all(assetTasks);
    evidence.assetSummary = Object.fromEntries(["html", "javascript", "css", "font", "other"].map(kind => {
      const rows = evidence.assets.filter(row => row.kind === kind);
      return [kind, { responses: rows.length, successfulResponses: rows.filter(row => row.status >= 200 && row.status < 300).length, responseBodyBytes: rows.reduce((sum, row) => sum + (row.responseBodyBytes ?? 0), 0) }];
    }));
    assert.ok(evidence.assets.some(row => row.kind === "html" && row.status === 200), "public route loaded actual hosted HTML");
    assert.ok(evidence.assets.some(row => row.kind === "javascript" && row.status === 200), "public route loaded actual hosted JavaScript");
    assert.ok(evidence.assets.some(row => row.kind === "css" && row.status === 200), "public route loaded actual hosted CSS");
    assert.equal(evidence.assetCaptureErrors, 0);
    assert.equal(evidence.browser.outsideHostRequests, 0, "browser HTTP and WebSocket traffic remains on the single public hostname");
    assert.ok(evidence.browser.websocketConnectionsWithFrames > 0, "hosted UI exchanged frames over the public WSS connection");
    assert.deepEqual(await verifyRelayClientInputs(sha256), relayInputsBefore, "Relay client source and installed ws dependency remain pinned throughout the run");
    evidence.state = "PASS";
    evidence.stage = "complete";
  } catch (error) {
    evidence.state = "FAIL";
    evidence.failureClass = safeFailureClass(error);
    evidence.failureDetails = safeFailureDetails(error);
    throw error;
  }
});

function assetKind(pathname, resourceType) {
  if (/\.html$/.test(pathname) || pathname.endsWith("/mobile/")) return "html";
  if (resourceType === "script" || /\.m?js$/.test(pathname)) return "javascript";
  if (resourceType === "stylesheet" || /\.css$/.test(pathname)) return "css";
  if (resourceType === "font" || /\.(?:woff2?|ttf|otf)$/.test(pathname)) return "font";
  return "other";
}

async function captureAsset(response, kind) {
  const request = response.request();
  const sizes = await request.sizes().catch(() => null);
  const requestHeaders = request.headers();
  const headers = response.headers();
  const timing = request.timing();
  const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
  const responseEnd = finite(timing.responseEnd);
  const requestStart = finite(timing.requestStart);
  return {
    kind,
    status: response.status(),
    contentType: headers["content-type"]?.split(";", 1)[0] ?? "unknown",
    contentEncoding: headers["content-encoding"] ?? "identity",
    responseBodyBytes: finite(sizes?.responseBodySize),
    responseHeaderBytes: finite(sizes?.responseHeadersSize),
    contentLengthBytes: finite(Number(headers["content-length"])),
    timing: { requestToResponseMs: requestStart === null || responseEnd === null ? null : Number((responseEnd - requestStart).toFixed(2)), totalMs: responseEnd },
    cache: {
      control: headers["cache-control"] ?? null,
      ageHeaderPresent: headers.age !== undefined,
      etagPresent: headers.etag !== undefined,
      conditionalRequest: requestHeaders["if-none-match"] !== undefined || requestHeaders["if-modified-since"] !== undefined,
      fromServiceWorker: response.fromServiceWorker(),
      revalidated: response.status() === 304,
    },
  };
}

function validateMobileEntry(value, { mobileUrl, gatewayBase, pairingToken, relaySecret }) {
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const exactKeys = isObject && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["available", "gatewayUrl", "mobileUrl", "version"]);
  let credentialFree = false;
  if (exactKeys && typeof value.mobileUrl === "string" && typeof value.gatewayUrl === "string") {
    try {
      const mobile = new URL(value.mobileUrl);
      const gateway = new URL(value.gatewayUrl);
      credentialFree = [mobile, gateway].every(url => url.protocol === "https:" && url.host === PUBLIC_HOST
        && !url.username && !url.password && !url.search && !url.hash)
        && !value.mobileUrl.includes(pairingToken) && !value.gatewayUrl.includes(pairingToken)
        && !value.mobileUrl.includes(relaySecret) && !value.gatewayUrl.includes(relaySecret);
    } catch { credentialFree = false; }
  }
  const available = exactKeys && value.available === true;
  const valid = exactKeys && value.version === 1 && available && credentialFree
    && value.mobileUrl === mobileUrl && value.gatewayUrl === gatewayBase;
  return { valid, available: Boolean(available) };
}

function safeNodeFetchFailure(error) {
  const allowed = new Set([
    "ABORT_ERR", "CERT_HAS_EXPIRED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
    "ENOTFOUND", "EAI_AGAIN", "ERR_TLS_CERT_ALTNAME_INVALID", "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "TimeoutError",
  ]);
  const code = error?.cause?.code ?? error?.code ?? error?.name;
  return allowed.has(code) ? code : "other";
}

function safeFailureClass(error) {
  const allowed = new Set(["AssertionError", "TimeoutError", "TypeError", "RangeError", "AbortError"]);
  return allowed.has(error?.name) ? error.name : "Error";
}

function safeFailureDetails(error) {
  if (error?.name !== "RelayIdentityReadError") return null;
  const allowedCodes = new Set(["SSH_TIMEOUT", "SSH_OUTPUT_LIMIT", "RELAY_IDENTITY_UNAVAILABLE", "RELAY_IDENTITY_INVALID"]);
  const allowedSignals = new Set(["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP", "SIGPIPE", "spawn-error"]);
  return {
    kind: "relay_identity_read",
    code: allowedCodes.has(error.code) ? error.code : null,
    exitCode: Number.isInteger(error.exitCode) && error.exitCode >= 0 && error.exitCode <= 255 ? error.exitCode : null,
    exitSignal: allowedSignals.has(error.exitSignal) ? error.exitSignal : null,
  };
}

async function verifyRelayClientInputs(sha256) {
  const sourceRows = [];
  for (const [path, expectedSha256] of Object.entries(RELAY_CLIENT_FILES)) {
    const followupBytes = await readFile(resolve(repoRoot, path));
    const mainBytes = await readFile(resolve(MAIN_REPO_ROOT, path));
    const followupSha256 = sha256(followupBytes);
    const mainSha256 = sha256(mainBytes);
    assert.equal(followupSha256, expectedSha256, `followup Relay source pin changed: ${path}`);
    assert.equal(mainSha256, expectedSha256, `main Relay source pin changed: ${path}`);
    assert.deepEqual(mainBytes, followupBytes, `Relay source checkouts differ: ${path}`);
    sourceRows.push([path, followupSha256]);
  }
  const sourceClosureSha256 = sha256(Buffer.from(sourceRows.map(([path, digest]) => `${path}\0${digest}\n`).join("")));

  const mainClientPath = resolve(MAIN_REPO_ROOT, "apps/kcoder-relay/src/client.mjs");
  const wsEntry = await realpath(createRequire(mainClientPath).resolve("ws"));
  const wsRoot = await realpath(resolve(MAIN_REPO_ROOT, "apps/kcoder-relay/node_modules/ws"));
  assert.equal(dirname(wsEntry), wsRoot, "Relay client resolves ws from the pinned main checkout dependency tree");
  const wsPackage = JSON.parse(await readFile(resolve(wsRoot, "package.json"), "utf8"));
  assert.equal(wsPackage.version, WS_RUNTIME_PIN.version);
  const wsRows = [];
  async function walkWsDirectory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walkWsDirectory(path);
        continue;
      }
      const info = await lstat(path);
      assert.ok(info.isFile() && !info.isSymbolicLink(), "ws dependency tree contains only regular files and directories");
      wsRows.push([relative(wsRoot, path).split("\\").join("/"), sha256(await readFile(path))]);
    }
  }
  await walkWsDirectory(wsRoot);
  wsRows.sort(([left], [right]) => left.localeCompare(right));
  const wsPackageTreeSha256 = sha256(Buffer.from(wsRows.map(([path, digest]) => `${path}\0${digest}\n`).join("")));
  assert.equal(wsPackageTreeSha256, WS_RUNTIME_PIN.packageTreeSha256, "installed ws package tree pin changed");
  return { sourceClosureSha256, wsVersion: wsPackage.version, wsPackageTreeSha256 };
}
