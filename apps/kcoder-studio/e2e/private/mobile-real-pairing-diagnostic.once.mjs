import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startChromium } from "../harness/chromium.mjs";
import { runE2E } from "../harness/run-context.mjs";

const GATEWAY_PID = 3455880;
const ORIGINS = ["http://127.0.0.1:4187", "http://100.64.0.58:4187"];
const EXPECTED_ENTRY = "entry-f3a6c29a5a12b870548b34be7e1509b9.js";
const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
const CATALOG_METHODS = new Set(["runtime.workspaces.list", "runtime.worktrees.list", "runtime.models.list"]);

function safePath(value) {
  try { return new URL(value).pathname; } catch { return "<invalid-route>"; }
}

function safeText(value, run) {
  return run.redactText(String(value ?? "")
    .replace(/(?:\/home\/|\/data\d*\/|\/Users\/)[^\s,;)]+/g, "<path>")
    .replace(/https?:\/\/[^\s]+/g, "<url>")
    .slice(0, 320));
}

function readProcToken(run) {
  return Promise.all([
    readFile(`/proc/${GATEWAY_PID}/status`, "utf8"),
    readFile(`/proc/${GATEWAY_PID}/environ`),
  ]).then(([status, raw]) => {
    assert.match(status, /^Name:\s+node\s*$/m, "expected the root-owned Gateway Node process");
    const entry = raw.toString("utf8").split("\0").find(value => value.startsWith("KCODER_STUDIO_AUTH_TOKEN="));
    const token = entry?.slice("KCODER_STUDIO_AUTH_TOKEN=".length) ?? "";
    assert.ok(token.length >= 32, "Gateway pairing token must be available in the owned Gateway environment");
    run.registerSecret(token);
    const encoded = encodeURIComponent(token);
    if (encoded !== token) run.registerSecret(encoded);
    return token;
  });
}

function rpcFrames(payload) {
  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed) ? parsed.filter(frame => frame && typeof frame === "object") : [parsed];
  } catch { return []; }
}

function inspectRpc(direction, socketId, payload, pending, rows) {
  for (const frame of rpcFrames(payload)) {
    if (direction === "sent" && typeof frame.method === "string" && frame.method.length <= 128) {
      const row = { method: frame.method, direction: "client-to-server", terminal: frame.id === undefined ? "notification" : "pending" };
      rows.push(row);
      if (frame.id !== undefined) pending.set(`${socketId}:${String(frame.id)}`, row);
    } else if (direction === "received" && frame.id !== undefined) {
      const row = pending.get(`${socketId}:${String(frame.id)}`);
      if (row) {
        row.terminal = Object.hasOwn(frame, "error") ? "error" : "result";
        pending.delete(`${socketId}:${String(frame.id)}`);
      } else if (typeof frame.method === "string" && frame.method.length <= 128) {
        rows.push({ method: frame.method, direction: "server-to-client", terminal: "notification" });
      }
    } else if (direction === "received" && typeof frame.method === "string" && frame.method.length <= 128) {
      rows.push({ method: frame.method, direction: "server-to-client", terminal: "notification" });
    }
  }
}

function observeLocationInit(page) {
  return page.addInitScript(() => {
    const observations = [];
    const capture = event => {
      const query = new URLSearchParams(location.search);
      observations.push({
        event,
        pathname: location.pathname,
        queryKeys: [...query.keys()].sort(),
        gatewayPresent: Boolean(query.get("gateway")),
        credentialQueryPresent: query.has("token"),
        credentialHashPresent: location.hash.startsWith("#token="),
      });
    };
    window.__pairingUrlObservations = observations;
    for (const method of ["pushState", "replaceState"]) {
      try {
        const original = history[method];
        history[method] = function (...args) {
          const result = original.apply(this, args);
          capture(`history.${method}`);
          return result;
        };
      } catch { /* The initial URL observation remains useful if History is locked. */ }
    }
    addEventListener("popstate", () => capture("popstate"));
    addEventListener("hashchange", () => capture("hashchange"));
    capture("document-init");
  });
}

function createEvidence(origin) {
  return {
    origin,
    pageStatus: null,
    pairingHttpStatus: null,
    profile: null,
    localStorageKeyCount: null,
    secureContext: null,
    webLocksAvailable: null,
    urlAtDocumentInit: null,
    urlAfterPairing: null,
    urlAfterNewNavigation: null,
    urlChanges: [],
    apiRoutes: [],
    scriptResponses: [],
    websocketConnections: [],
    rpcMethods: [],
    catalogUi: null,
    pageErrorCount: 0,
    cleanup: null,
    durationMs: null,
  };
}

async function runPairingAndCatalog(run, chromium, origin, pairingToken) {
  const startedAt = Date.now();
  const deadline = startedAt + 30_000;
  const remaining = requested => Math.max(1, Math.min(requested, deadline - Date.now()));
  const evidence = createEvidence(origin);
  let sessionToken = null;
  let cleanupResult = null;
  const browserContext = await chromium.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", colorScheme: "dark" });
  run.addCleanup(`close pairing context ${new URL(origin).host}`, () => browserContext.close().catch(() => undefined));

  const revokeOwnSession = async () => {
    if (cleanupResult) return cleanupResult;
    if (!sessionToken) {
      cleanupResult = { status: null, outcome: "no-session-token-captured" };
      return cleanupResult;
    }
    try {
      const response = await fetch(`${origin}/api/mobile/session`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${sessionToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      cleanupResult = { status: response.status, outcome: response.status === 204 ? "revoked-this-diagnostic-session-and-device" : "revoke-rejected" };
    } catch (error) {
      cleanupResult = { status: null, outcome: error?.name === "TimeoutError" ? "timeout" : "request-failed" };
    }
    evidence.cleanup = cleanupResult;
    return cleanupResult;
  };
  run.addCleanup(`revoke pairing created on ${new URL(origin).host}`, revokeOwnSession);

  try {
    const page = await browserContext.newPage();
    await observeLocationInit(page);
    page.on("pageerror", () => { evidence.pageErrorCount += 1; });
    page.on("request", request => {
      try {
        const url = new URL(request.url());
        if (url.origin === origin && url.pathname.startsWith("/api/")) evidence.apiRoutes.push({ method: request.method(), route: safePath(url.href), status: null });
      } catch { /* Do not retain request URLs. */ }
    });
    page.on("response", response => {
      try {
        const url = new URL(response.url());
        if (url.origin !== origin) return;
        if (response.request().resourceType() === "script") evidence.scriptResponses.push({ route: safePath(url.href), file: url.pathname.split("/").at(-1), status: response.status() });
        if (url.pathname.startsWith("/api/")) {
          const row = [...evidence.apiRoutes].reverse().find(item => item.status === null && item.route === safePath(url.href));
          if (row) row.status = response.status();
        }
      } catch { /* Ignore malformed response URLs. */ }
    });

    const cdp = await browserContext.newCDPSession(page);
    run.addCleanup(`detach CDP ${new URL(origin).host}`, () => cdp.detach().catch(() => undefined));
    await cdp.send("Network.enable");
    const pending = new Map();
    const socketIds = new Map();
    cdp.on("Network.webSocketCreated", event => {
      try {
        const url = new URL(event.url);
        if (url.host === new URL(origin).host) {
          const socket = { route: safePath(url.href), handshakeStatus: null };
          evidence.websocketConnections.push(socket);
          socketIds.set(event.requestId, socket);
        }
      } catch { /* Never retain query strings or credentials. */ }
    });
    cdp.on("Network.webSocketHandshakeResponseReceived", event => {
      const socket = socketIds.get(event.requestId);
      if (socket) socket.handshakeStatus = event.response.status;
    });
    cdp.on("Network.webSocketFrameSent", event => inspectRpc("sent", event.requestId, event.response.payloadData, pending, evidence.rpcMethods));
    cdp.on("Network.webSocketFrameReceived", event => inspectRpc("received", event.requestId, event.response.payloadData, pending, evidence.rpcMethods));

    const pairResponsePromise = page.waitForResponse(response => {
      try { const url = new URL(response.url()); return response.request().method() === "POST" && url.origin === origin && url.pathname === "/api/mobile/session"; }
      catch { return false; }
    }, { timeout: remaining(14_000) }).then(async response => {
      evidence.pairingHttpStatus = response.status();
      if (!response.ok()) return { status: response.status(), payload: null };
      const payload = await response.json();
      for (const key of ["accessToken", "rpcToken", "refreshToken"]) {
        if (typeof payload?.[key] === "string" && payload[key].length >= 8) run.registerSecret(payload[key]);
      }
      sessionToken = typeof payload?.accessToken === "string" ? payload.accessToken : null;
      return { status: response.status(), payload };
    }).catch(error => ({ status: null, errorName: error?.name ?? "PairingWaitError" }));

    const connectUrl = `${origin}/mobile/connect?gateway=${encodeURIComponent(origin)}#token=${encodeURIComponent(pairingToken)}`;
    const pageResponse = await page.goto(connectUrl, { waitUntil: "domcontentloaded", timeout: remaining(10_000) });
    evidence.pageStatus = pageResponse?.status() ?? null;
    evidence.urlAtDocumentInit = await page.evaluate(() => window.__pairingUrlObservations?.[0] ?? null);
    const pair = await pairResponsePromise;
    if (pair.status !== 200 || !sessionToken) {
      evidence.pairingWait = pair.errorName ?? null;
      evidence.pairingHttpStatus ??= pair.status;
      throw new Error("pairing-not-successful");
    }
    const profileHandle = await page.waitForFunction(({ key, origin: expectedOrigin }) => {
      try {
        const raw = localStorage.getItem(key);
        const index = raw ? JSON.parse(raw) : null;
        const profiles = Array.isArray(index?.profiles) ? index.profiles : [];
        const profile = profiles.find(item => typeof item?.id === "string" && typeof item?.baseUrl === "string" && new URL(item.baseUrl).origin === expectedOrigin);
        if (!profile) return null;
        const base = new URL(profile.baseUrl);
        return { id: profile.id, baseUrl: `${base.origin}${base.pathname.replace(/\/$/, "")}`, authMode: profile.authMode ?? null, keyCount: localStorage.length };
      } catch { return null; }
    }, { key: PROFILE_INDEX_KEY, origin }, { timeout: remaining(7_000), polling: 50 });
    const profile = await profileHandle.jsonValue();
    evidence.profile = { id: profile.id, baseUrl: profile.baseUrl, authMode: profile.authMode };
    evidence.localStorageKeyCount = profile.keyCount;
    const contextFlags = await page.evaluate(() => ({ secureContext: window.isSecureContext, webLocksAvailable: typeof navigator.locks?.request === "function" }));
    evidence.secureContext = contextFlags.secureContext;
    evidence.webLocksAvailable = contextFlags.webLocksAvailable;
    evidence.urlAfterPairing = await page.evaluate(() => {
      const query = new URLSearchParams(location.search);
      return { pathname: location.pathname, queryKeys: [...query.keys()].sort(), gatewayPresent: Boolean(query.get("gateway")), credentialQueryPresent: query.has("token"), credentialHashPresent: location.hash.startsWith("#token="), addressBarCredentialFree: !query.has("token") && !location.hash.startsWith("#token=") };
    });

    const newUrl = `${origin}/mobile/new?profileId=${encodeURIComponent(profile.id)}&serverId=local`;
    const newResponse = await page.goto(newUrl, { waitUntil: "domcontentloaded", timeout: remaining(8_000) });
    evidence.newPageStatus = newResponse?.status() ?? null;
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="model-selector"]') || document.querySelector('[data-testid="new-workspace-error"]')), null, { timeout: remaining(7_000), polling: 50 }).catch(() => undefined);
    const catalogDeadline = Math.min(deadline, Date.now() + 20_000);
    while (Date.now() < catalogDeadline) {
      const settled = new Set(evidence.rpcMethods.filter(row => row.terminal === "result" || row.terminal === "error").map(row => row.method));
      if ([...CATALOG_METHODS].every(method => settled.has(method)) || await page.getByTestId("new-workspace-error").count()) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    evidence.catalogUi = await page.evaluate(() => {
      const error = document.querySelector('[data-testid="new-workspace-error"]');
      const model = document.querySelector('[data-testid="model-selector"]');
      const query = new URLSearchParams(location.search);
      return {
        visibleError: error?.textContent?.trim() ?? null,
        modelSelectorVisible: Boolean(model),
        modelSelectorDisabled: model?.getAttribute("aria-disabled") === "true" || model?.hasAttribute("disabled"),
        workspaceOptionCount: document.querySelectorAll('[data-testid^="workspace-option-"]').length,
        pathname: location.pathname,
        queryKeys: [...query.keys()].sort(),
        credentialQueryPresent: query.has("token"),
        credentialHashPresent: location.hash.startsWith("#token="),
        addressBarCredentialFree: !query.has("token") && !location.hash.startsWith("#token="),
      };
    });
    evidence.catalogUi.visibleError = safeText(evidence.catalogUi.visibleError, run);
    evidence.urlAfterNewNavigation = {
      pathname: evidence.catalogUi.pathname,
      queryKeys: evidence.catalogUi.queryKeys,
      credentialQueryPresent: evidence.catalogUi.credentialQueryPresent,
      credentialHashPresent: evidence.catalogUi.credentialHashPresent,
      addressBarCredentialFree: evidence.catalogUi.addressBarCredentialFree,
    };
    evidence.urlChanges = await page.evaluate(() => window.__pairingUrlObservations?.slice(1) ?? []);
    evidence.scriptEntryLoaded = evidence.scriptResponses.some(row => row.file === EXPECTED_ENTRY && row.status === 200);
    evidence.catalogRpcMethods = evidence.rpcMethods.filter(row => CATALOG_METHODS.has(row.method));
    const clientMethods = evidence.rpcMethods.filter(row => row.direction === "client-to-server").map(row => row.method);
    evidence.observedWriteMethods = [...new Set(clientMethods.filter(method =>
      /^(?:thread|task|turn)\/(?:start|create)$/i.test(method) ||
      /^(?:runtime\.)?workspaces?\.(?:create|prepare\w*|open\w*)$/i.test(method) ||
      /^(?:runtime\.)?worktrees?\.(?:create|prepare\w*)$/i.test(method)))];
    evidence.noBrowserTurnStartObserved = !clientMethods.includes("turn/start");
    evidence.noBrowserTaskCreationObserved = evidence.observedWriteMethods.length === 0;
    await cdp.detach().catch(() => undefined);
  } catch (error) {
    evidence.failureStage = error?.message === "pairing-not-successful" ? "pairing" : error?.name ?? "diagnostic-error";
  } finally {
    evidence.cleanup = await revokeOwnSession();
    await browserContext.close().catch(() => undefined);
    evidence.durationMs = Date.now() - startedAt;
  }
  return evidence;
}

async function runInvalidLinkProbe(run, chromium, origin, pairingToken) {
  const evidence = { origin, pageStatus: null, secureContext: null, webLocksAvailable: null, gatewayParamPresent: false, credentialHashInitiallyPresent: true, credentialQueryPresent: false, pairingPostCount: 0, apiRoutes: [], visibleError: null, cleanup: { outcome: "no-session-created" } };
  const browserContext = await chromium.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", colorScheme: "dark" });
  run.addCleanup("close invalid-link browser context", () => browserContext.close().catch(() => undefined));
  const page = await browserContext.newPage();
  page.on("request", request => {
    try {
      const url = new URL(request.url());
      if (url.origin !== origin || !url.pathname.startsWith("/api/")) return;
      evidence.apiRoutes.push({ method: request.method(), route: safePath(url.href) });
      if (request.method() === "POST" && url.pathname === "/api/mobile/session") evidence.pairingPostCount += 1;
    } catch { /* Do not retain request URLs. */ }
  });
  const invalidUrl = `${origin}/mobile/connect#token=${encodeURIComponent(pairingToken)}`;
  const response = await page.goto(invalidUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
  evidence.pageStatus = response?.status() ?? null;
  await page.waitForTimeout(2_500);
  const state = await page.evaluate(() => ({
    secureContext: window.isSecureContext,
    webLocksAvailable: typeof navigator.locks?.request === "function",
    gatewayParamPresent: Boolean(new URLSearchParams(location.search).get("gateway")),
    credentialHashPresent: location.hash.startsWith("#token="),
    credentialQueryPresent: new URLSearchParams(location.search).has("token"),
    visibleError: document.querySelector('[role="alert"]')?.textContent?.trim() ?? document.body?.innerText ?? "",
  }));
  evidence.secureContext = state.secureContext;
  evidence.webLocksAvailable = state.webLocksAvailable;
  evidence.hashMarkerPresent = state.credentialHashPresent;
  evidence.credentialQueryPresent = state.credentialQueryPresent;
  evidence.visibleError = safeText(state.visibleError, run);
  await browserContext.close().catch(() => undefined);
  return evidence;
}

await runE2E(import.meta.url, {
  testId: "mobile-real-pairing-readonly-catalog-diagnostic-once",
  tier: "manual-live",
  modelPolicy: "real Mobile UI pairing and read-only catalog diagnostic against the root-owned Gateway; no independent Gateway acceptance, no model request, and no task creation",
  targetOwner: `root-owned Gateway PID ${GATEWAY_PID} on port 4187`,
}, async run => {
  const pairingToken = await readProcToken(run);
  const chromium = await startChromium(run, { label: "mobile-real-pairing-diagnostic-chromium", executablePath: "/usr/bin/chromium", noSandbox: true });
  const result = {
    classification: "browser-only/model-independent evidence against root-owned preview; not independent Gateway or real-model acceptance",
    gatewayPid: GATEWAY_PID,
    expectedServedEntry: EXPECTED_ENTRY,
    origins: [],
    invalidLink: null,
  };
  for (const origin of ORIGINS) result.origins.push(await runPairingAndCatalog(run, chromium, origin, pairingToken));
  result.invalidLink = await runInvalidLinkProbe(run, chromium, ORIGINS[0], pairingToken);
  result.summary = {
    originPairingHttp200: result.origins.every(row => row.pairingHttpStatus === 200),
    originProfilesFromUi: result.origins.every(row => Boolean(row.profile?.id && row.profile.authMode)),
    originNewPageHttp200: result.origins.every(row => row.newPageStatus === 200),
    credentialFreeAfterPairAndNavigation: result.origins.every(row => row.urlAfterPairing?.addressBarCredentialFree && row.urlAfterNewNavigation?.addressBarCredentialFree),
    allOwnedSessionsRevoked: result.origins.every(row => row.cleanup?.status === 204),
    invalidLinkHadZeroPairPosts: result.invalidLink?.pairingPostCount === 0,
    browserTurnStartAbsent: result.origins.every(row => row.noBrowserTurnStartObserved === true),
    browserTaskCreationAbsent: result.origins.every(row => row.noBrowserTaskCreationObserved === true),
    loopbackDevicePairing: result.origins[0]?.profile?.authMode === "device",
    loopbackCatalogRpcObserved: ["runtime.models.list", "runtime.workspaces.list"].every(method => (result.origins[0]?.catalogRpcMethods ?? []).some(row => row.method === method && row.terminal === "result")) && !result.origins[0]?.catalogUi?.visibleError,
    tailscaleLegacyFenceVisible: result.origins[1]?.profile?.authMode === "legacy" && result.origins[1]?.catalogUi?.visibleError?.includes("Gateway 授权归属已变化或无法确认"),
  };
  await run.writeArtifactJson("mobile-real-pairing-readonly-catalog-diagnostic.json", result);
  assert.ok(result.summary.allOwnedSessionsRevoked, "every session created by this diagnostic must be revoked");
  assert.ok(result.summary.invalidLinkHadZeroPairPosts, "the valid-token/missing-gateway case must be rejected before session exchange");
  assert.equal(result.invalidLink.hashMarkerPresent, false, "invalid link fragment must be removed");
  assert.ok(result.invalidLink.visibleError.includes("配对链接缺少必要信息"), "invalid link must show the missing details error");
  assert.ok(result.summary.browserTurnStartAbsent && result.summary.browserTaskCreationAbsent, "browser RPC ledger must show no turn or task creation methods");
  assert.ok(result.summary.credentialFreeAfterPairAndNavigation, "application navigation must remove pairing credential from query and hash");
  assert.ok(result.summary.originPairingHttp200 && result.summary.originProfilesFromUi && result.summary.originNewPageHttp200, "both origins must pair through the real UI and reach /mobile/new");
  assert.ok(result.summary.loopbackCatalogRpcObserved, "loopback catalog must receive actual model and workspace results");
  assert.ok(result.summary.tailscaleLegacyFenceVisible, "plain HTTP Tailscale must expose the known Web Locks fence");
  return result;
});
