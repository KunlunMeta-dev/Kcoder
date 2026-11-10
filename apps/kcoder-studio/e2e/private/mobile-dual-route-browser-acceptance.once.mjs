// One-shot real Chromium acceptance of Mobile Web LAN-first/public-Relay pairing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createMobileWebStatic } from "../../src/mobile-web-static.js";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { startBrowserDualRouteFixture } from "./mobile-dual-route-browser-fixture.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { appRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const RUN_FLAG = "KCODER_E2E_PRIVATE_MOBILE_DUAL_ROUTE_BROWSER_ACCEPTANCE";
const CSP = [
  "default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
  "form-action 'self'", "script-src 'self' 'wasm-unsafe-eval' 'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: http: https:", "font-src 'self' data:",
  "connect-src 'self' ws: wss: http: https:", "worker-src 'self' blob:", "frame-src 'self' http: https:",
  "media-src 'self' blob: http: https:",
].join("; ");

if (process.env[RUN_FLAG] !== "1") {
  throw new Error(`${RUN_FLAG}=1 is required for this private one-shot browser acceptance`);
}
const noSandbox = process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1";
const requireSandbox = process.env.KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX === "1";
if (noSandbox === requireSandbox) {
  throw new Error("set exactly one of KCODER_E2E_CHROMIUM_NO_SANDBOX=1 or KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX=1 before starting the owned browser");
}

await runE2E(import.meta.url, {
  testId: "mobile-dual-route-real-browser-acceptance",
  tier: "manual-live",
  retainSuccessLogs: true,
  modelPolicy: "real Mobile Web build in RunContext-owned Chromium; actual Gateway auth, signed route probes and in-process Relay path; deterministic KCODER_STUDIO_MOCK RPC only, no Provider/model; localhost and owned HTTP fixture only, not production TLS, public Internet, Local Network Access permission, or phone acceptance",
}, async context => {
  const mobileWeb = await exportMobileWeb(context, {
    label: "dual-route-browser-current-mobile-export",
    outputName: "current-mobile-web-export",
    timeoutMs: 180_000,
    overallTimeoutMs: 240_000,
    sourceMaps: false,
    deployMount: true,
  });
  const mobileManifest = await buildGatewayMobileWebManifest(mobileWeb.path);
  await writeGatewayMobileWebManifest(mobileWeb.path, mobileManifest);
  const mobileManifestSha256 = createHash("sha256").update(await readFile(resolve(mobileWeb.path, "kcoder-mobile-web.json"))).digest("hex");
  const evidence = {
    status: "incomplete",
    mobileWebExport: {
      sourceTreeSha256: mobileWeb.sourceTreeSha256,
      buildInputTreeSha256: mobileWeb.buildInputTreeSha256,
      dependencySourceTreeSha256: mobileWeb.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: mobileWeb.dependencyOwnedTreeSha256,
      bundleSha256: mobileWeb.bundleSha256,
      bundleFileCount: mobileWeb.bundleFileCount,
      indexHtmlSha256: mobileWeb.indexHtmlSha256,
      manifestSha256: mobileManifestSha256,
      manifestFileCount: mobileManifest.files.length,
    },
    boundary: "real browser UI over localhost secure context; owned RFC1918 Gateway/Relay-path fixture; mock workspace/history RPC; no public Internet, production TLS, model/provider, or phone claim",
    legacyQueryLinkBrowser: "not exercised in this one-profile acceptance; pairing parser compatibility remains covered by Mobile tests",
    markerLegend: {
      markerA: "pairing token present in URL fragment/query",
      markerB: "pairing token found in browser persistence",
      headerA: "Authorization header present",
      headerB: "Cookie header present",
      allowAmbientFlag: "Access-Control-Allow-Credentials response is true",
      requestMode: "page fetch Request.credentials value observed by wrapper",
    },
    pna: "unverified until actual browser preflight observation",
  };
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url || "/", "http://localhost").pathname;
      if (await serveMobile(request, response, pathname)) return;
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(500, { "cache-control": "no-store" });
      response.end();
    }
  });
  let port = 0;
  const originFor = () => `http://localhost:${port}`;
  const publicOrigins = new Set();
  const serveMobile = createMobileWebStatic({
    root: mobileWeb.path,
    publicOrigins,
    directPort: () => port,
    contentSecurityPolicy: CSP,
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  port = server.address().port;
  publicOrigins.add(originFor());
  context.registerPort("mobile-dual-route-browser-web-origin", port);
  context.addCleanup("close owned Mobile Web origin", () => closeServer(server));

  const fixture = await startBrowserDualRouteFixture(context, { mobileWebOrigin: originFor() });
  const { pairing, routes } = fixture;
  context.registerSecret(pairing.token);
  const pairingLink = makeFragmentPairingLink(originFor(), pairing, routes);

  let chromium;
  const oldUmask = process.umask(0o077);
  try {
    chromium = await startChromium(context, {
      label: "mobile-dual-route-browser",
      profileName: "mobile-dual-route-browser",
      windowSize: { width: 390, height: 844 },
    });
  } catch (error) {
    evidence.failure = safeBrowserError(context, error?.stack ?? error?.message ?? error);
    throw error;
  } finally {
    process.umask(oldUmask);
  }
  evidence.mobileWebOrigin = originFor();
  evidence.browserVersion = chromium.browser.version();
  evidence.noSandbox = chromium.noSandbox;
  evidence.mobileStaticHandler = "createMobileWebStatic with build-manifest/hash verification and mount token substitution";
  evidence.signedRouteKinds = routes.endpoints.map(endpoint => endpoint.kind);

  const page = await chromium.newPersistentPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(observePageCalls);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  context.addCleanup("detach owned Mobile Web CDP observer", async () => {
    try { await cdp.detach(); } catch { /* Chromium may already be closing after a failed test. */ }
  });
  const cdpPreflights = observeCdpPreflights(cdp, originFor(), fixture);
  const sockets = [];
  const browserNetwork = [];
  const networkTasks = [];
  const browserErrors = { page: [], console: [], requestFailures: [] };
  page.on("websocket", socket => observeSocket(socket, sockets));
  page.on("pageerror", error => browserErrors.page.push({ name: error.name, ...safeBrowserError(context, error.message) }));
  page.on("console", message => { if (message.type() === "error") browserErrors.console.push(safeBrowserError(context, message.text())); });
  page.on("requestfailed", request => {
    let url;
    try { url = new URL(request.url()); } catch { return; }
    browserErrors.requestFailures.push({ method: request.method(), path: url.pathname, ...safeBrowserError(context, request.failure()?.errorText || "") });
  });
  page.on("response", response => {
    const task = observeNetworkResponse(response, originFor(), fixture).then(record => {
      if (record) browserNetwork.push(record);
    });
    networkTasks.push(task);
  });
  const sessionResponsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname.endsWith("/api/mobile/session");
  }, { timeout: 25_000 });
  let phase = "browser-ready";
  try {
    const documentResponse = await page.goto(pairingLink, { waitUntil: "domcontentloaded", timeout: 15_000 });
    phase = "pairing-page-opened";
    evidence.documentStatus = documentResponse?.status() ?? null;
    await page.waitForFunction(() => !location.hash && !new URLSearchParams(location.search).has("token"), null, { timeout: 10_000 });
    phase = "pairing-fragment-scrubbed";
    const sessionResponse = await sessionResponsePromise;
    phase = "pairing-session-exchanged";
    const session = await sessionResponse.json();
    registerSessionSecrets(context, session);
    await page.getByTestId("sessions").waitFor({ state: "visible", timeout: 25_000 });

    await page.getByTestId("sessions").click();
    await page.getByTestId("session-mock-active-session").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("session-mock-active-session").click();
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("message-user").filter({ hasText: "历史附件" }).waitFor({ state: "visible", timeout: 20_000 });

    const profile = await readStoredProfile(page, pairing.token, pairing.publicBaseUrl);
    const deviceCount = await fixture.adminDeviceCount();
    const calls = await page.evaluate(() => window.__mobileRouteAudit);
    await flushNetworkTasks(networkTasks);
    evidence.page = {
      secureContext: calls.initial.secureContext,
      webCrypto: calls.initial.webCrypto,
      webLocks: calls.initial.webLocks,
      initialFragmentMarker: calls.initial.fragmentToken,
      initialQueryMarker: calls.initial.queryToken,
      currentUrlMarker: await page.evaluate(() => Boolean(location.hash || new URLSearchParams(location.search).has("token"))),
      historyScrubbedMarker: calls.history.some(entry => entry.hadFragmentToken && !entry.fragmentToken && !entry.queryToken),
      storedMarkerFound: profile.pairingCredentialStored,
      profileCount: profile.profileCount,
      profileId: profile.id,
      profileBaseIsCanonicalPublicUrl: profile.baseUrl === pairing.publicBaseUrl,
      deviceIdPresent: Boolean(profile.deviceId),
      deviceId: profile.deviceId,
      gatewayDeviceCount: deviceCount,
      lockCalls: calls.locks,
      fetches: summarizeFetches(calls.fetches),
      maxParallelRouteProbes: calls.maxParallelProofs,
      webSockets: summarizeSockets(sockets),
      rpcMethods: collectMethods(sockets),
    };
    evidence.fixtureRecords = sanitizeRecords(fixture.records);
    evidence.browserNetwork = browserNetwork;
    evidence.pna = classifyPna(fixture.records, cdpPreflights);
    evidence.screenshot = "mobile-390-paired-history.png";
    await page.screenshot({ path: context.pathInArtifacts(evidence.screenshot), fullPage: true });

    assert.equal(calls.initial.secureContext, true, "the actual Mobile page must have a secure context");
    assert.equal(calls.initial.webCrypto, true, "the actual Mobile page must use native WebCrypto");
    assert.equal(calls.initial.webLocks, true, "the actual Mobile page must expose native Web Locks");
    assert.equal(evidence.page.initialFragmentMarker, true, "pairing credential must enter through the URL fragment");
    assert.equal(evidence.page.initialQueryMarker, false, "pairing credential must not enter through the URL query");
    assert.equal(evidence.page.currentUrlMarker, false, "pairing credential must be removed from the current URL");
    assert.equal(evidence.page.historyScrubbedMarker, true, "the Mobile page must scrub the pairing credential with history replacement");
    assert.equal(profile.pairingCredentialStored, false, "the pairing credential must not be persisted in web storage");
    assert.equal(profile.profileCount, 1, "the actual pairing UI must persist exactly one Gateway profile");
    assert.equal(profile.baseUrl, pairing.publicBaseUrl, "the profile must retain the QR canonical public Gateway URL");
    assert.equal(deviceCount, 1, "the Gateway must contain exactly one browser device");
    assert.ok(calls.locks.some(lock => lock.name === "kcoder-mobile:gateway-profile-index" && lock.mode === "exclusive"), "profile persistence must use the native exclusive Web Lock");
    assertPageTransportSecurity(calls.fetches, evidence);
    assertCorsPreflight(browserNetwork, cdpPreflights, fixture.records, evidence);
    assertRouteFixture(fixture.records, "lan", evidence, { requireSession: true, requireUpgrade: true });
    assertRpcResults(sockets, ["initialize", "thread/list", "thread/read"]);
    assertSocketRoute(sockets, "lan", ["initialize", "thread/list"]);
    assertSocketRoute(sockets, "lan", ["initialize", "thread/read"]);

    phase = "paired-ui-loaded";
    const identity = { id: profile.id, deviceId: profile.deviceId };
    const publicRecordStart = fixture.records.length;
    const publicSocketStart = sockets.length;
    fixture.setLanDown(true);
    phase = "lan-disabled-observe-automatic-fallback";
    const publicSocket = await waitFor(
      () => socketWithResults(sockets.slice(publicSocketStart), "public", ["initialize", "thread/read"]),
      25_000,
      "Mobile Web automatic public Relay RPC after LAN WebSocket loss",
      100,
      context.abortSignal,
    );
    phase = "automatic-public-relay-after-lan-loss";
    await flushNetworkTasks(networkTasks);
    const publicHistoryVisible = await page.getByTestId("message-user").filter({ hasText: "历史附件" }).isVisible();
    evidence.publicFallback = { automatic: {
      route: publicSocket.route,
      rpcResults: publicSocket.terminalResponses,
      historyVisible: publicHistoryVisible,
      pairingPostOnPublic: fixture.records.slice(publicRecordStart).some(record =>
        record.method === "POST" && record.path.endsWith("/api/mobile/session") && record.route === "public"),
    } };
    assertRouteFixture(fixture.records, "public", evidence, { requireUpgrade: true });
    assert.equal(evidence.publicFallback.automatic.pairingPostOnPublic, false,
      "the pairing credential exchange must not be replayed through public Relay during failover");
    assert.equal(evidence.publicFallback.automatic.historyVisible, true,
      "history must remain visible while the actual public Relay thread/read RPC succeeds");

    const publicReloadSocketStart = sockets.length;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 25_000 });
    await page.getByTestId("message-user").filter({ hasText: "历史附件" }).waitFor({ state: "visible", timeout: 25_000 });
    const publicReloadSocket = await waitFor(
      () => socketWithResults(sockets.slice(publicReloadSocketStart), "public", ["initialize", "thread/read"]),
      25_000,
      "Mobile Web public Relay RPC after profile reload",
      100,
      context.abortSignal,
    );
    await flushNetworkTasks(networkTasks);
    const publicReloadAudit = await page.evaluate(() => window.__mobileRouteAudit);
    assertReloadProofs(publicReloadAudit.fetches, "public profile reload", "public", evidence);
    const afterPublicReload = await readStoredProfile(page, pairing.token, pairing.publicBaseUrl);
    const publicDeviceCount = await fixture.adminDeviceCount();
    evidence.publicFallback.afterReload = {
      route: publicReloadSocket.route,
      rpcResults: publicReloadSocket.terminalResponses,
      profileIdStable: afterPublicReload.id === identity.id,
      deviceIdStable: afterPublicReload.deviceId === identity.deviceId,
      profileCount: afterPublicReload.profileCount,
      gatewayDeviceCount: publicDeviceCount,
      storedMarkerFound: afterPublicReload.pairingCredentialStored,
      historyVisible: true,
    };
    assert.equal(evidence.publicFallback.afterReload.profileIdStable, true, "profile identity must survive public-route reload");
    assert.equal(evidence.publicFallback.afterReload.deviceIdStable, true, "device identity must survive public-route reload");
    assert.equal(evidence.publicFallback.afterReload.profileCount, 1, "public-route reload must not create a second profile");
    assert.equal(publicDeviceCount, 1, "public-route reload must not create a second Gateway device");
    assert.equal(evidence.publicFallback.afterReload.storedMarkerFound, false, "pairing token must remain absent after public-route reload");

    const recoveryRecordStart = fixture.records.length;
    const recoverySocketStart = sockets.length;
    fixture.setLanDown(false);
    phase = "lan-restored-before-reload";
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.getByTestId("task-header-title").waitFor({ state: "visible", timeout: 25_000 });
    await page.getByTestId("message-user").filter({ hasText: "历史附件" }).waitFor({ state: "visible", timeout: 25_000 });
    const lanSocket = await waitFor(
      () => socketWithResults(sockets.slice(recoverySocketStart), "lan", ["initialize", "thread/read"]),
      25_000,
      "Mobile Web LAN RPC after LAN recovery",
      100,
      context.abortSignal,
    );
    phase = "lan-preferred-after-recovery";
    await flushNetworkTasks(networkTasks);
    const recoveryAudit = await page.evaluate(() => window.__mobileRouteAudit);
    assertReloadProofs(recoveryAudit.fetches, "LAN recovery", "lan", evidence);
    const afterRecovery = await readStoredProfile(page, pairing.token, pairing.publicBaseUrl);
    const recoveryDeviceCount = await fixture.adminDeviceCount();
    evidence.lanRecovery = {
      route: lanSocket.route,
      rpcResults: lanSocket.terminalResponses,
      lockCalls: recoveryAudit.locks,
      routeProbes: summarizeFetches(recoveryAudit.fetches.filter(fetch => fetch.proof)),
      lanRequests: sanitizeRecords(fixture.records.slice(recoveryRecordStart).filter(record => record.route === "lan")),
      profileIdStable: afterRecovery.id === identity.id,
      deviceIdStable: afterRecovery.deviceId === identity.deviceId,
      profileCount: afterRecovery.profileCount,
      gatewayDeviceCount: recoveryDeviceCount,
      storedMarkerFound: afterRecovery.pairingCredentialStored,
      historyVisible: await page.getByTestId("message-user").filter({ hasText: "历史附件" }).isVisible(),
    };
    assertRouteFixture(fixture.records.slice(recoveryRecordStart), "lan", evidence, { requireUpgrade: true });
    assert.equal(evidence.lanRecovery.profileIdStable, true, "profile identity must survive LAN recovery reload");
    assert.equal(evidence.lanRecovery.deviceIdStable, true, "device identity must survive LAN recovery reload");
    assert.equal(evidence.lanRecovery.profileCount, 1, "LAN recovery must not create a second profile");
    assert.equal(recoveryDeviceCount, 1, "LAN recovery must not create a second Gateway device");
    assert.equal(evidence.lanRecovery.storedMarkerFound, false, "pairing token must remain absent after recovery reload");
    assert.equal(evidence.lanRecovery.historyVisible, true, "history must remain readable after LAN recovery");
    evidence.screenshot = "mobile-390-lan-recovered-history.png";
    await page.screenshot({ path: context.pathInArtifacts(evidence.screenshot), fullPage: true });
    evidence.status = "browser-pairing-lan-public-recovery-pass";
  } catch (error) {
    evidence.failure = safeBrowserError(context, error?.stack ?? error?.message ?? error);
    throw error;
  } finally {
    await flushNetworkTasks(networkTasks);
    evidence.phase = phase;
    evidence.fixtureRecords = sanitizeRecords(fixture.records);
    evidence.browserNetwork = browserNetwork;
    evidence.cdpPreflights = cdpPreflights;
    evidence.browserErrors = browserErrors;
    evidence.pna = classifyPna(fixture.records, cdpPreflights);
    if (page && !page.isClosed()) {
      try {
        const snapshot = await page.evaluate(() => ({
          pathname: location.pathname,
          queryKeys: [...new Set([...new URLSearchParams(location.search).keys()])].sort(),
          hasToken: Boolean(location.hash || new URLSearchParams(location.search).has("token")),
          secureContext: window.isSecureContext,
          audit: window.__mobileRouteAudit ?? null,
          ui: {
            hasConnectError: /Connection failed|连接失败/i.test(document.body?.innerText ?? ""),
            hasConnectProgress: /Establishing a secure connection|正在建立安全连接/i.test(document.body?.innerText ?? ""),
            hasHistoryTitle: /Mobile task operation test|移动任务操作测试/i.test(document.body?.innerText ?? ""),
            alertText: document.querySelector('[role="alert"]')?.textContent ?? "",
            documentTitle: document.title,
            bodyChildCount: document.body?.children.length ?? 0,
            rootChildCount: document.getElementById("root")?.children.length ?? null,
          },
        }));
        evidence.browserPage = {
          pathname: snapshot.pathname,
          queryKeys: snapshot.queryKeys,
          urlMarker: snapshot.hasToken,
          secureContext: snapshot.secureContext,
          ui: { ...snapshot.ui, alertSummary: safeBrowserError(context, snapshot.ui.alertText).summary },
          audit: snapshot.audit ? {
            initial: summarizeInitialAudit(snapshot.audit.initial),
            history: summarizeHistory(snapshot.audit.history),
            fetches: summarizeFetches(snapshot.audit.fetches),
            maxParallelRouteProbes: snapshot.audit.maxParallelProofs,
            locks: snapshot.audit.locks,
          } : null,
        };
        if (!evidence.screenshot && !snapshot.hasToken) {
          evidence.screenshot = "mobile-390-token-cleared-diagnostic.png";
          await page.screenshot({ path: context.pathInArtifacts(evidence.screenshot), fullPage: true });
        }
      } catch (error) { evidence.browserPageSnapshot = safeBrowserError(context, error?.message ?? error); }
    }
    evidence.fixtureRecords = sanitizeRecords(fixture.records);
    evidence.browserNetwork = browserNetwork;
    evidence.cdpPreflights = cdpPreflights;
    evidence.browserErrors = browserErrors;
    evidence.pna = classifyPna(fixture.records, cdpPreflights);
    evidence.sockets = summarizeSockets(sockets);
    await context.writeArtifactJson("browser-acceptance.json", evidence);
  }
  return { status: evidence.status, deviceCount: evidence.page?.gatewayDeviceCount ?? null };
});

function makeFragmentPairingLink(mobileOrigin, pairing, routes) {
  const link = new URL(`${mobileOrigin}/mobile/connect`);
  link.searchParams.set("gateway", pairing.publicBaseUrl);
  link.searchParams.set("routes", JSON.stringify(routes));
  link.hash = new URLSearchParams({ token: pairing.token }).toString();
  return link.toString();
}

function observePageCalls() {
  const audit = {
    initial: {
      secureContext: window.isSecureContext,
      webCrypto: Boolean(window.crypto?.subtle),
      webLocks: typeof navigator.locks?.request === "function",
      fragmentToken: new URLSearchParams(location.hash.slice(1)).has("token"),
      queryToken: new URLSearchParams(location.search).has("token"),
    },
    history: [], fetches: [], locks: [], maxParallelProofs: 0, activeProofs: 0,
  };
  Object.defineProperty(window, "__mobileRouteAudit", { value: audit, configurable: false });
  const replaceState = history.replaceState.bind(history);
  history.replaceState = (state, title, value) => {
    const url = new URL(value == null ? location.href : String(value), location.href);
    audit.history.push({
      path: url.pathname,
      queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
      hadFragmentToken: new URLSearchParams(location.hash.slice(1)).has("token"),
      fragmentToken: new URLSearchParams(url.hash.slice(1)).has("token"),
      queryToken: url.searchParams.has("token"),
    });
    return replaceState(state, title, value);
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    let url;
    try { url = new URL(typeof input === "string" ? input : input.url, location.href); }
    catch { return originalFetch(input, init); }
    const requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const proof = url.pathname.endsWith("/api/mobile/connection-proof");
    const record = {
      method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
      path: url.pathname,
      route: url.pathname.startsWith("/g/") ? "public" : "lan",
      credentials: init?.credentials ?? (input instanceof Request ? input.credentials : "default"),
      headerA: requestHeaders.has("authorization"),
      headerB: requestHeaders.has("cookie"),
      proof,
      status: null,
      failed: false,
    };
    audit.fetches.push(record);
    if (proof) {
      audit.activeProofs += 1;
      audit.maxParallelProofs = Math.max(audit.maxParallelProofs, audit.activeProofs);
    }
    return originalFetch(input, init).then(response => {
      record.status = response.status;
      return response;
    }, error => {
      record.failed = true;
      record.failureKind = error?.name === "AbortError" ? "aborted" : "fetch-error";
      throw error;
    }).finally(() => { if (proof) audit.activeProofs -= 1; });
  };
  const locks = navigator.locks;
  if (locks && typeof locks.request === "function") {
    const request = locks.request.bind(locks);
    try {
      Object.defineProperty(locks, "request", {
        configurable: true,
        value(...args) {
          const [name, optionsOrCallback] = args;
          const options = args.length > 2 ? optionsOrCallback : undefined;
          audit.locks.push({
            name: name === "kcoder-mobile:gateway-profile-index" ? name : "other",
            mode: typeof options === "object" && options ? options.mode ?? "default" : "default",
          });
          return request(...args);
        },
      });
    } catch { /* The browser audit reports no Web Lock call if native observation cannot be installed. */ }
  }
}

function observeSocket(socket, sockets) {
  let url;
  try { url = new URL(socket.url()); }
  catch { return; }
  const isPublic = url.pathname.startsWith("/g/");
  const socketRecord = {
    route: isPublic ? "public" : "lan",
    path: url.pathname,
    queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
    sentMethods: [],
    receivedMethods: [],
    terminalResponses: [],
  };
  const pendingMethods = new Map();
  sockets.push(socketRecord);
  const inspect = (payload, direction) => {
    let frames;
    try { frames = JSON.parse(typeof payload === "string" ? payload : payload.toString()); }
    catch { return; }
    for (const frame of Array.isArray(frames) ? frames : [frames]) {
      if (typeof frame?.method === "string") {
        socketRecord[direction].push(frame.method);
        if (direction === "sentMethods" && frame.id !== undefined) pendingMethods.set(String(frame.id), frame.method);
      } else if (direction === "receivedMethods" && frame?.id !== undefined &&
        (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"))) {
        const method = pendingMethods.get(String(frame.id));
        if (method) {
          socketRecord.terminalResponses.push({
            method,
            terminal: Object.hasOwn(frame, "result") ? "result" : "error",
          });
          pendingMethods.delete(String(frame.id));
        }
      }
    }
  };
  socket.on("framesent", event => inspect(event.payload, "sentMethods"));
  socket.on("framereceived", event => inspect(event.payload, "receivedMethods"));
  socket.on("close", () => { socketRecord.closed = true; });
}

async function observeNetworkResponse(response, mobileOrigin, fixture) {
  let url;
  try { url = new URL(response.url()); } catch { return null; }
  const request = response.request();
  const isMobileApi = url.pathname.includes("/api/mobile/");
  const isOptions = request.method() === "OPTIONS";
  if (!isMobileApi && !isOptions && url.origin !== mobileOrigin) return null;
  const [requestHeaders, responseHeaders] = await Promise.all([request.allHeaders(), response.allHeaders()]);
  const publicPrefix = `/g/${new URL(fixture.publicUrl).pathname.split("/")[2]}`;
  const route = url.origin === mobileOrigin ? "mobile-web" : url.pathname.startsWith(publicPrefix) ? "public" : "lan";
  return {
    method: request.method(),
    path: url.pathname,
    queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
    route,
    status: response.status(),
    requestHasOrigin: typeof requestHeaders.origin === "string",
    requestOriginMatchesMobileWeb: requestHeaders.origin === mobileOrigin,
    headerA: typeof requestHeaders.authorization === "string",
    headerB: typeof requestHeaders.cookie === "string",
    hasPrivateNetworkRequestHeader: requestHeaders["access-control-request-private-network"] === "true",
    requestedMethod: requestHeaders["access-control-request-method"] ?? null,
    requestedHeaders: headerTokens(requestHeaders["access-control-request-headers"]),
    allowOriginMatchesMobileWeb: responseHeaders["access-control-allow-origin"] === mobileOrigin,
    allowMethods: headerTokens(responseHeaders["access-control-allow-methods"]),
    allowHeaders: headerTokens(responseHeaders["access-control-allow-headers"]),
    allowAmbientFlag: responseHeaders["access-control-allow-credentials"] === "true",
    hasPrivateNetworkAllowResponse: responseHeaders["access-control-allow-private-network"] === "true",
  };
}

function observeCdpPreflights(cdp, mobileOrigin, fixture) {
  const records = [];
  const byRequestId = new Map();
  cdp.on("Network.requestWillBeSent", event => {
    if (event.type !== "Preflight" && event.request.method !== "OPTIONS") return;
    let url;
    try { url = new URL(event.request.url); } catch { return; }
    if (!url.pathname.startsWith("/api/")) return;
    const requestHeaders = lowerHeaders(event.request.headers);
    const record = {
      method: event.request.method,
      path: url.pathname,
      queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
      route: cdpRoute(url, mobileOrigin, fixture),
      type: event.type ?? null,
      originMatchesMobileWeb: requestHeaders.origin === mobileOrigin,
      requestedMethod: requestHeaders["access-control-request-method"]?.toLowerCase() ?? null,
      requestedHeaders: headerTokens(requestHeaders["access-control-request-headers"]),
      pnaRequest: requestHeaders["access-control-request-private-network"] === "true",
      responseStatus: null,
      allowOriginMatchesMobileWeb: false,
      allowMethods: [],
      allowHeaders: [],
      allowAmbientFlag: false,
      pnaAllowed: false,
    };
    records.push(record);
    byRequestId.set(event.requestId, record);
  });
  cdp.on("Network.responseReceivedExtraInfo", event => {
    const record = byRequestId.get(event.requestId);
    if (!record) return;
    const responseHeaders = lowerHeaders(event.headers);
    record.responseStatus = event.statusCode;
    record.allowOriginMatchesMobileWeb = responseHeaders["access-control-allow-origin"] === mobileOrigin;
    record.allowMethods = headerTokens(responseHeaders["access-control-allow-methods"]);
    record.allowHeaders = headerTokens(responseHeaders["access-control-allow-headers"]);
    record.allowAmbientFlag = responseHeaders["access-control-allow-credentials"] === "true";
    record.pnaAllowed = responseHeaders["access-control-allow-private-network"] === "true";
  });
  return records;
}

function cdpRoute(url, mobileOrigin, fixture) {
  if (url.origin === mobileOrigin) return "mobile-web";
  const publicPrefix = `/g/${new URL(fixture.publicUrl).pathname.split("/")[2]}`;
  return url.pathname.startsWith(publicPrefix) ? "public" : "lan";
}

function lowerHeaders(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
}

function headerTokens(value) {
  return typeof value === "string" ? value.split(",").map(item => item.trim().toLowerCase()).filter(Boolean).sort() : [];
}

function safeBrowserError(context, value) {
  const summary = context.redactText(String(value))
    .replace(/https?:\/\/[^\s"'<>]+/g, raw => {
      try { const url = new URL(raw); return `${url.origin}${url.pathname}`; }
      catch { return "[url]"; }
    })
    .slice(0, 300);
  return { category: classifyError(value), summary };
}

function classifyError(value) {
  const message = String(value);
  if (/access-control-allow-private-network|private network access|local network access/i.test(message)) return "pna-or-lna-block";
  if (/cors|access-control-allow-origin|preflight/i.test(message)) return "cors-block";
  if (/content security policy|refused to (?:load|connect|execute)/i.test(message)) return "csp-block";
  if (/ERR_NETWORK_ACCESS_DENIED|ERR_FAILED|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_REFUSED/i.test(message)) return "network-block";
  return "browser-error";
}

async function readStoredProfile(page, pairingToken, canonicalPublicUrl) {
  return page.evaluate(({ pairingToken, canonicalPublicUrl }) => {
    const raw = localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2");
    const index = raw ? JSON.parse(raw) : { profiles: [], activeId: null };
    const profiles = Array.isArray(index.profiles) ? index.profiles : [];
    const active = profiles.find(profile => profile.id === index.activeId) ?? profiles[0] ?? null;
    let pairingCredentialStored = false;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      const value = key ? localStorage.getItem(key) : null;
      if (value?.includes(pairingToken)) pairingCredentialStored = true;
    }
    return {
      profileCount: profiles.length,
      id: active?.id ?? null,
      baseUrl: active?.baseUrl ?? null,
      deviceId: active?.deviceId ?? null,
      canonicalPublicUrlMatches: active?.baseUrl === canonicalPublicUrl,
      pairingCredentialStored,
    };
  }, { pairingToken, canonicalPublicUrl });
}

function registerSessionSecrets(context, session) {
  for (const key of ["accessToken", "rpcToken", "refreshToken"]) {
    if (typeof session?.[key] === "string" && session[key].length >= 8) context.registerSecret(session[key]);
  }
}

function summarizeFetches(fetches) {
  return fetches.map(({ method, path, route, credentials, headerA, headerB, proof, status, failed, failureKind }) => ({
    method, path, route, requestMode: credentials, headerA, headerB, proof, status, failed, ...(failureKind ? { failureKind } : {}),
  }));
}

function collectMethods(sockets) {
  return [...new Set(sockets.flatMap(socket => [
    ...socket.sentMethods,
    ...socket.receivedMethods,
    ...socket.terminalResponses.map(response => response.method),
  ]))].sort();
}

function summarizeSockets(sockets) {
  return sockets.map(socket => ({
    route: socket.route,
    path: socket.path,
    queryKeys: socket.queryKeys,
    sentMethods: socket.sentMethods,
    receivedMethods: socket.receivedMethods,
    terminalResponses: socket.terminalResponses,
    closed: Boolean(socket.closed),
  }));
}

function socketWithResults(sockets, route, methods) {
  return sockets.find(socket => socket.route === route && methods.every(method =>
    socket.terminalResponses.some(response => response.method === method && response.terminal === "result")));
}

function assertRpcResults(sockets, methods) {
  for (const method of methods) {
    assert.ok(sockets.some(socket => socket.terminalResponses.some(response =>
      response.method === method && response.terminal === "result")),
    `the actual RPC WebSocket must receive a result for ${method}`);
  }
}

function assertSocketRoute(sockets, route, methods) {
  const socket = socketWithResults(sockets, route, methods);
  assert.ok(socket, `the actual RPC WebSocket must receive successful ${methods.join(", ")} results on ${route}`);
  return socket;
}

function assertPageTransportSecurity(fetches, evidence) {
  const session = fetches.find(fetch => fetch.method === "POST" && fetch.path.endsWith("/api/mobile/session"));
  assert.ok(session, "the actual Mobile UI must POST the pairing exchange from the page");
  assert.equal(session.credentials, "omit", "pairing exchange must omit ambient browser credentials");
  assert.equal(session.headerA, false, "pairing exchange must not send an Authorization header");
  assert.equal(session.headerB, false, "pairing exchange must not send a Cookie header");
  const proofs = fetches.filter(fetch => fetch.path.endsWith("/api/mobile/connection-proof"));
  assert.ok(proofs.length >= 2, "the page must probe both signed route candidates");
  assert.ok(proofs.some(fetch => fetch.route === "lan") && proofs.some(fetch => fetch.route === "public"),
    "the page must attempt both the LAN and public signed route candidates");
  assert.ok(proofs.every(fetch => fetch.credentials === "omit" && !fetch.headerA && !fetch.headerB),
    "all route proof requests must omit ambient credentials and authorization/cookie headers");
  assert.ok(proofs.some(fetch => fetch.route === "lan" && fetch.status === 200 && !fetch.failed),
    "the LAN-first route proof must succeed in the browser page");
  const cancelledLosers = proofs.filter(fetch => fetch.failed);
  assert.ok(cancelledLosers.every(fetch => fetch.failureKind === "aborted"),
    "only losing parallel proof requests cancelled by the route winner may fail");
  assert.ok(evidence.page.maxParallelRouteProbes >= 2, "the browser page must run route proof requests in parallel");
  evidence.routeProofs = {
    requestCount: proofs.length,
    parallelMaximum: evidence.page.maxParallelRouteProbes,
    successfulLanWinnerCount: proofs.filter(fetch => fetch.route === "lan" && fetch.status === 200).length,
    cancelledLoserCount: cancelledLosers.length,
  };
}

function assertCorsPreflight(browserNetwork, cdpPreflights, fixtureRecords, evidence) {
  const preflight = cdpPreflights.find(record => record.path === "/api/mobile/session");
  assert.ok(preflight, "Chromium must perform the session exchange CORS preflight");
  assert.equal(preflight.responseStatus, 204, "the CORS preflight must succeed with HTTP 204");
  assert.equal(preflight.originMatchesMobileWeb, true, "the preflight Origin must be the actual Mobile Web origin");
  assert.equal(preflight.allowOriginMatchesMobileWeb, true, "the preflight must allow the actual Mobile Web origin");
  assert.equal(preflight.requestedMethod, "post", "the preflight must be for the actual pairing POST");
  assert.ok(preflight.requestedHeaders.includes("content-type"), "the preflight must include the JSON Content-Type header");
  assert.ok(preflight.allowMethods.includes(preflight.requestedMethod), "the preflight response must allow its requested method");
  assert.ok(preflight.requestedHeaders.every(header => preflight.allowHeaders.includes(header)),
    "the preflight response must allow every requested header");
  const fixturePreflight = fixtureRecords.find(record => record.method === "OPTIONS" && record.path === "/api/mobile/session");
  assert.ok(fixturePreflight, "the isolated Gateway fixture must receive the browser session preflight");
  assert.equal(fixturePreflight.responseStatus, 204, "the Gateway fixture must answer the actual preflight with HTTP 204");
  assert.equal(fixturePreflight.corsAllowOriginMatchesRequest, true, "the Gateway fixture must allow the browser Origin");
  const sessionResponse = browserNetwork.find(record => record.method === "POST" &&
    record.path.endsWith("/api/mobile/session") && record.status === 200);
  assert.ok(sessionResponse, "the actual pairing POST must succeed after its CORS preflight");
  assert.equal(sessionResponse.requestOriginMatchesMobileWeb, true, "the pairing POST must carry the actual Mobile Web Origin");
  assert.equal(sessionResponse.allowOriginMatchesMobileWeb, true, "the pairing POST response must allow the actual Mobile Web Origin");
  assert.equal(sessionResponse.headerA, false, "the actual pairing POST must not carry Authorization");
  assert.equal(sessionResponse.headerB, false, "the actual pairing POST must not carry Cookie");
  evidence.cors = {
    exercised: true,
    observer: "Chromium CDP Network requestWillBeSent(Preflight) and responseReceivedExtraInfo",
    sessionOptionsStatus: preflight.responseStatus,
    originMatched: preflight.allowOriginMatchesMobileWeb,
    requestedMethod: preflight.requestedMethod,
    requestedHeaders: preflight.requestedHeaders,
    allowedMethods: preflight.allowMethods,
    allowedHeaders: preflight.allowHeaders,
    sessionPostStatus: sessionResponse.status,
    sessionPostOriginMatched: sessionResponse.allowOriginMatchesMobileWeb,
    allowAmbientFlag: preflight.allowAmbientFlag,
    pnaRequest: preflight.pnaRequest,
    pnaAllowed: preflight.pnaAllowed,
  };
}

function assertRouteFixture(records, route, evidence, options = {}) {
  const routeRecords = records.filter(record => record.route === route);
  const proof = routeRecords.find(record => record.method === "GET" &&
    record.path.endsWith("/api/mobile/connection-proof") && record.responseStatus === 200);
  assert.ok(proof, `the owned ${route} fixture must return an actual route proof`);
  if (options.requireUpgrade) {
    const socket = routeRecords.find(record => record.upgrade && record.responseStatus === 101);
    assert.ok(socket, `the owned ${route} fixture must complete an actual WebSocket upgrade`);
  }
  if (options.requireSession) {
    const exchange = routeRecords.find(record => record.method === "POST" && record.path.endsWith("/api/mobile/session") && record.responseStatus === 200);
    assert.ok(exchange, "the actual pairing session POST must be accepted by the selected LAN Gateway");
    assert.equal(exchange.hasOrigin, true, "the pairing POST must carry a browser Origin");
    assert.equal(exchange.corsAllowOriginMatchesRequest, true, "the pairing POST response must allow the page Origin");
    assert.equal(records.some(record => record.method === "POST" &&
      record.path.endsWith("/api/mobile/session") && record.route === "public"), false,
    "the pairing credential exchange must not be broadcast through public Relay");
  }
  evidence[`route-${route}`] = {
    proofHttp200: true,
    websocketUpgrade101: Boolean(routeRecords.some(record => record.upgrade && record.responseStatus === 101)),
    sessionPostHttp200: Boolean(routeRecords.some(record => record.method === "POST" && record.path.endsWith("/api/mobile/session") && record.responseStatus === 200)),
  };
}

async function flushNetworkTasks(networkTasks) {
  const pending = networkTasks.splice(0);
  if (pending.length) await Promise.allSettled(pending);
}

function summarizeInitialAudit(initial) {
  return {
    secureContext: initial.secureContext,
    webCrypto: initial.webCrypto,
    webLocks: initial.webLocks,
    markerA: initial.fragmentToken,
    markerB: initial.queryToken,
  };
}

function assertReloadProofs(fetches, stage, expectedRoute, evidence) {
  const proofs = fetches.filter(fetch => fetch.path.endsWith("/api/mobile/connection-proof"));
  assert.ok(proofs.length >= 2, `${stage} must probe both signed route candidates`);
  assert.ok(proofs.every(fetch => fetch.credentials === "omit" && !fetch.headerA && !fetch.headerB),
    `${stage} route probes must omit ambient credentials and authorization/cookie headers`);
  assert.ok(proofs.some(fetch => fetch.route === expectedRoute && fetch.status === 200 && !fetch.failed),
    `${stage} must receive a real ${expectedRoute} route proof response`);
  evidence.reloadProofAudits ??= [];
  evidence.reloadProofAudits.push({ stage, expectedRoute, requests: summarizeFetches(proofs) });
}

function summarizeHistory(history) {
  return history.map(entry => ({
    path: entry.path,
    queryKeys: entry.queryKeys,
    beforeMarkerA: entry.hadFragmentToken,
    afterMarkerA: entry.fragmentToken,
    afterMarkerB: entry.queryToken,
  }));
}

function sanitizeRecords(records) {
  return records.map(record => ({
    method: record.method,
    path: record.path,
    queryKeys: record.queryKeys,
    headerA: record.hasAuthorization,
    headerB: record.hasCookie,
    hasOrigin: record.hasOrigin,
    hasPrivateNetworkRequestHeader: record.hasPrivateNetworkRequestHeader,
    hasRequestedMethodHeader: record.hasRequestedMethodHeader,
    upgrade: record.upgrade,
    route: record.route,
    responseStatus: record.responseStatus,
    hasCorsAllowOriginResponse: record.hasCorsAllowOriginResponse,
    corsAllowOriginMatchesRequest: record.corsAllowOriginMatchesRequest,
    hasPrivateNetworkAllowResponse: record.hasPrivateNetworkAllowResponse,
    transportFailure: record.transportFailure,
  }));
}

function classifyPna(records, browserPreflights = []) {
  const preflights = records.filter(record => record.method === "OPTIONS");
  const browserPnaCount = browserPreflights.filter(record => record.pnaRequest).length;
  const triggered = browserPnaCount > 0 || preflights.some(record => record.hasPrivateNetworkRequestHeader);
  return {
    state: triggered ? "triggered" : "unexercised",
    preflightCount: preflights.length,
    browserPreflightCount: browserPreflights.length,
    privateNetworkRequestCount: Math.max(browserPnaCount, preflights.filter(record => record.hasPrivateNetworkRequestHeader).length),
    privateNetworkAllowResponseCount: Math.max(
      browserPreflights.filter(record => record.pnaAllowed).length,
      preflights.filter(record => record.hasPrivateNetworkAllowResponse).length,
    ),
    localNetworkAccessPermission: "unverified; no permission was pre-granted or bypassed",
  };
}

async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolveClosed => server.close(() => resolveClosed()));
}
