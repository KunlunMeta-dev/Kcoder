import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const ORIGIN = "http://127.0.0.1:14178";
const ORIGIN_URL = new URL(ORIGIN);
const LINK_FILE = "/tmp/kcoder-mobile-hmr-preview-20261014/gateway/mobile-one-click-login-url.local.txt";
const LOGIN_COOKIE = "kcoder_studio_session";
const PAGE_VIEWPORT = { width: 390, height: 844 };
const FORBIDDEN_RPC = /^(?:thread|task|turn)\/(?:start|create|resume|steer|delete|archive|unarchive)|^(?:runtime\.)?(?:workspaces|worktrees)\.(?:create|prepare\w*|open|refresh|delete)/i;
const PRODUCT_SOURCE_FILES = [
  "apps/kcoder-studio/mobile/src/app/h/[profileId]/index.tsx",
  "apps/kcoder-studio/mobile/src/components/thread-list-presentation.ts",
  "apps/kcoder-studio/mobile/src/gateway/http.ts",
  "apps/kcoder-studio/mobile/src/runtime/task-runtime/workspaces.ts",
];

function defaultPort(protocol) {
  return protocol === "https:" || protocol === "wss:" ? "443" : "80";
}

function isPreviewAuthority(url) {
  const expectedPort = ORIGIN_URL.port || defaultPort(ORIGIN_URL.protocol);
  const observedPort = url.port || defaultPort(url.protocol);
  return url.hostname === ORIGIN_URL.hostname && observedPort === expectedPort;
}

function registerSecret(run, value) {
  if (typeof value !== "string" || value.length < 8) return;
  run.registerSecret(value);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) run.registerSecret(encoded);
}

async function readPrivateLink(run) {
  const privateRoot = "/tmp/kcoder-mobile-hmr-preview-20261014";
  const privateGateway = `${privateRoot}/gateway`;
  for (const directory of [privateRoot, privateGateway]) {
    const stat = await lstat(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "preview credential directory must be a real directory");
    assert.equal(stat.uid, process.getuid(), "preview credential directory must belong to this user");
    assert.equal(stat.mode & 0o077, 0, "preview credential directory must be private");
  }
  const stat = await lstat(LINK_FILE);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "preview login link must be a private regular file");
  assert.equal(stat.uid, process.getuid(), "preview login link must belong to this user");
  assert.equal(stat.mode & 0o077, 0, "preview login link must be private");

  const raw = (await readFile(LINK_FILE, "utf8")).trim();
  registerSecret(run, raw);
  const link = new URL(raw);
  assert.equal(link.origin, ORIGIN, "login link must target the assigned loopback preview");
  assert.equal(link.username, "");
  assert.equal(link.password, "");
  const loginToken = link.searchParams.get("token");
  const pairing = new URLSearchParams(link.hash.slice(1));
  const pairingToken = pairing.get("token");
  const returnTo = link.searchParams.get("returnTo");
  assert.ok(loginToken && pairingToken && returnTo, "login link must contain both owned credentials and a return route");
  registerSecret(run, loginToken);
  registerSecret(run, pairingToken);

  const prefix = link.pathname.replace(/\/+$/, "").replace(/\/login$/, "");
  assert.ok(prefix.startsWith("/g/") && prefix.length > 3, "login link must be mounted under the owned preview route");
  const gatewayBase = `${ORIGIN}${prefix}`;
  const connect = new URL(returnTo, ORIGIN);
  assert.equal(connect.origin, ORIGIN, "pairing return route must remain loopback-local");
  assert.equal(connect.pathname, `${prefix}/mobile/connect`, "pairing return route must use the Mobile connect UI");
  assert.deepEqual([...connect.searchParams.keys()].sort(), ["gateway"]);
  assert.equal(connect.searchParams.get("gateway"), gatewayBase);
  assert.equal(connect.hash, "");
  connect.hash = `token=${encodeURIComponent(pairingToken)}`;
  registerSecret(run, connect.href);
  return { prefix, gatewayBase, loginPath: link.pathname, loginToken, pairingToken, returnTo, connectUrl: connect.href };
}

async function postLogin(run, link) {
  const body = new URLSearchParams({ token: link.loginToken, returnTo: link.returnTo });
  const response = await fetch(`${ORIGIN}${link.loginPath}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const cookieHeader = setCookies.find(value => value.startsWith(`${LOGIN_COOKIE}=`));
  if (cookieHeader) registerSecret(run, cookieHeader);
  const firstPair = cookieHeader?.split(";", 1)[0] ?? "";
  const separator = firstPair.indexOf("=");
  const cookieValue = separator >= 0 ? firstPair.slice(separator + 1) : "";
  registerSecret(run, cookieValue);
  const path = cookieHeader?.match(/(?:^|;)\s*Path=([^;]+)/i)?.[1] ?? "/";
  return {
    status: response.status,
    locationPath: response.headers.get("location")
      ? new URL(response.headers.get("location"), ORIGIN).pathname
      : null,
    cookie: cookieValue ? {
      name: LOGIN_COOKIE,
      value: cookieValue,
      path,
      secure: /(?:^|;)\s*Secure(?:;|$)/i.test(cookieHeader),
      sameSite: "Strict",
    } : null,
  };
}

function parseFrames(payload) {
  if (typeof payload !== "string" || payload.length > 512_000) return [];
  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed) ? parsed.filter(frame => frame && typeof frame === "object") : [parsed];
  } catch {
    return [];
  }
}

function routeOnly(value) {
  try {
    const url = new URL(value);
    return url.pathname;
  } catch {
    return "<invalid-route>";
  }
}

function safeTargetInventory(servers) {
  if (!Array.isArray(servers)) return [];
  return servers.map(target => ({
    id: typeof target?.id === "string" ? target.id : null,
    label: typeof target?.label === "string" ? target.label : null,
    labelKey: typeof target?.labelKey === "string" ? target.labelKey : null,
    transport: typeof target?.transport === "string" ? target.transport : null,
    workspacePath: typeof target?.workspacePath === "string" ? target.workspacePath : null,
  }));
}

async function fingerprintProductSource() {
  const aggregate = createHash("sha256");
  const files = [];
  for (const pathFromRoot of PRODUCT_SOURCE_FILES) {
    const bytes = await readFile(resolve(repoRoot, pathFromRoot));
    const digest = createHash("sha256").update(bytes).digest("hex");
    aggregate.update(pathFromRoot + "\0" + digest + "\n");
    files.push({ path: pathFromRoot, sha256: digest });
  }
  return { fileCount: files.length, files, aggregateSha256: aggregate.digest("hex") };
}

function installLocationObserver(page) {
  return page.addInitScript(() => {
    const rows = [];
    const record = event => {
      const query = new URLSearchParams(location.search);
      const fragment = new URLSearchParams(location.hash.slice(1));
      rows.push({
        event,
        pathname: location.pathname,
        queryKeys: [...query.keys()].sort(),
        gatewayPresent: query.has("gateway"),
        queryCredentialPresent: query.has("token"),
        fragmentKeys: [...fragment.keys()].sort(),
        pairingFragmentPresent: fragment.has("token"),
      });
    };
    Object.defineProperty(window, "__previewLocationEvidence", { value: rows, configurable: false });
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function (...args) {
        const value = original.apply(this, args);
        record(`history.${method}`);
        return value;
      };
    }
    addEventListener("popstate", () => record("popstate"));
    addEventListener("hashchange", () => record("hashchange"));
    record("document-init");
  });
}

await runE2E(import.meta.url, {
  testId: "mobile-hmr-home-actual-preview-row-once",
  tier: "manual-live",
  modelPolicy: "real loopback Mobile HMR UI and owned pairing only; Home catalog reads; no model request, task creation, refresh action, configuration write, or registry mutation",
  targetOwner: "this RunContext Chromium profile plus the diagnostic's own Gateway login and Mobile device sessions",
}, async run => {
  const startedAt = Date.now();
  const sourceAtStart = await fingerprintProductSource();
  const evidence = {
    boundary: "actual 14178 Mobile preview capture; no test workspace, localStorage injection, thread opening, explicit refresh, or model request",
    capture: {
      classification: "actual-preview-current-capture; not a historical Before snapshot",
      timestamp: null,
      sourceScope: PRODUCT_SOURCE_FILES,
      sourceHead: run.gitCommit,
      productFilesAtStart: sourceAtStart.files,
      productAggregateSha256AtStart: sourceAtStart.aggregateSha256,
      sourceStableDuringCapture: null,
      productFilesAfterScreenshot: null,
      productAggregateSha256AfterScreenshot: null,
    },
    login: { method: "POST /login", status: null, cookieInstalled: false, cookiePath: null, logoutStatus: null },
    browser: { pageStatus: null, homeMounted: false, addressCredentialFree: false, hmrBundleLoaded: false, hmrSocketStatuses: [], webSocketHandshakes: [], entryScripts: [], pageErrorCount: 0 },
    pairing: { status: null, addressCredentialFreeAfterPairing: false, profileReady: false },
    apiRoutes: [],
    rpcMethods: [],
    forbiddenRpcMethods: [],
    apiServerInventory: { source: null, status: null, version: null, targets: [] },
    home: { workspaceRows: [] },
    screenshots: [],
    rpcResponses: [],
    cleanup: { deviceStatus: null, deviceOutcome: "not-created", gatewayLogoutStatus: null },
    failureStage: null,
  };
  let stage = "credential-preflight";
  let link = null;
  let login = null;
  let mobileAccessToken = null;
  let browserContext = null;
  let cdp = null;
  const apiRouteMap = new Map();
  let deviceRevoked = false;
  let gatewayLoggedOut = false;
  let contextClosed = false;

  const revokeOwnDevice = async () => {
    if (deviceRevoked) return;
    deviceRevoked = true;
    if (!mobileAccessToken || !link) return;
    try {
      const response = await fetch(`${ORIGIN}${link.prefix}/api/mobile/session`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${mobileAccessToken}` },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      evidence.cleanup.deviceStatus = response.status;
      evidence.cleanup.deviceOutcome = response.status === 204 ? "own-device-revoked" : "revoke-rejected";
    } catch (error) {
      evidence.cleanup.deviceOutcome = error?.name === "TimeoutError" ? "revoke-timeout" : "revoke-request-failed";
    }
    mobileAccessToken = null;
  };
  const logoutOwnGatewaySession = async () => {
    if (gatewayLoggedOut) return;
    gatewayLoggedOut = true;
    if (!login?.cookie || !link) return;
    try {
      const response = await fetch(`${ORIGIN}${link.prefix}/logout`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: `${login.cookie.name}=${login.cookie.value}` },
        signal: AbortSignal.timeout(5_000),
      });
      evidence.cleanup.gatewayLogoutStatus = response.status;
      evidence.login.logoutStatus = response.status;
    } catch (error) {
      evidence.cleanup.gatewayLogoutStatus = error?.name === "TimeoutError" ? "timeout" : "request-failed";
      evidence.login.logoutStatus = evidence.cleanup.gatewayLogoutStatus;
    }
  };
  const closeContext = async () => {
    if (contextClosed) return;
    contextClosed = true;
    await browserContext?.close().catch(() => undefined);
  };

  try {
    link = await readPrivateLink(run);
    stage = "gateway-login";
    login = await postLogin(run, link);
    evidence.login.status = login.status;
    evidence.login.cookieInstalled = Boolean(login.cookie);
    evidence.login.cookiePath = login.cookie?.path ?? null;
    if (login.status !== 303 || !login.cookie) throw new Error("gateway-login-not-established");
    run.addCleanup("logout only this diagnostic Gateway session", logoutOwnGatewaySession);

    stage = "chromium-launch";
    const chrome = await startChromium(run, {
      label: "mobile-hmr-home-actual-preview-row",
      profileName: "mobile-hmr-home-actual-preview-row",
      executablePath: "/opt/google/chrome/chrome",
      noSandbox: true,
      windowSize: PAGE_VIEWPORT,
      startTimeoutMs: 20_000,
    });
    stage = "browser-context-create";
    browserContext = await chrome.browser.newContext({ viewport: PAGE_VIEWPORT, locale: "zh-CN" });
    run.addCleanup("close only this diagnostic browser context", closeContext);
    await browserContext.addCookies([{
      name: login.cookie.name,
      value: login.cookie.value,
      domain: ORIGIN_URL.hostname,
      path: login.cookie.path,
      httpOnly: true,
      secure: login.cookie.secure,
      sameSite: login.cookie.sameSite,
    }]);
    const page = await browserContext.newPage();
    await installLocationObserver(page);
    page.on("pageerror", () => { evidence.browser.pageErrorCount += 1; });
    page.on("request", request => {
      try {
        const url = new URL(request.url());
        if (url.origin === ORIGIN && url.pathname.startsWith(`${link.prefix}/api/`)) {
          const key = `${request.method()} ${url.pathname}`;
          if (!apiRouteMap.has(key)) apiRouteMap.set(key, { method: request.method(), route: url.pathname, status: null });
        }
      } catch { /* Keep request evidence route-only. */ }
    });
    page.on("response", response => {
      try {
        const url = new URL(response.url());
        if (url.origin !== ORIGIN) return;
        if (response.request().resourceType() === "script" && evidence.browser.entryScripts.length < 32) {
          evidence.browser.entryScripts.push({ route: url.pathname, status: response.status() });
        }
        const key = `${response.request().method()} ${url.pathname}`;
        const route = apiRouteMap.get(key);
        if (route) route.status = response.status();
        if (response.request().method() === "GET" && url.pathname === `${link.prefix}/api/servers`) {
          evidence.apiServerInventory.liveGetStatus = response.status();
          if (response.ok()) {
            void response.json().then(payload => {
              evidence.apiServerInventory = {
                ...evidence.apiServerInventory,
                source: "GET /api/servers response",
                status: response.status(),
                version: null,
                targets: safeTargetInventory(payload?.servers),
                liveGetStatus: response.status(),
              };
            }).catch(() => { evidence.apiServerInventory.liveGetProjection = "unavailable"; });
          }
        }
      } catch { /* Keep response evidence route-only. */ }
    });

    cdp = await browserContext.newCDPSession(page);
    run.addCleanup("detach only this diagnostic CDP session", () => cdp?.detach().catch(() => undefined));
    await cdp.send("Network.enable");
    const socketKinds = new Map();
    const rpcRequests = new Map();
    cdp.on("Network.webSocketCreated", event => {
      try {
        const url = new URL(event.url);
        if (!isPreviewAuthority(url)) return;
        if (url.pathname === `${link.prefix}/rpc`) {
          socketKinds.set(event.requestId, { kind: "rpc" });
        } else {
          socketKinds.set(event.requestId, {
            kind: url.pathname.startsWith(`${link.prefix}/mobile`) ? "hmr" : "preview",
            route: url.pathname,
            status: null,
          });
        }
      } catch { /* Never persist websocket URLs or query values. */ }
    });
    cdp.on("Network.webSocketHandshakeResponseReceived", event => {
      const socket = socketKinds.get(event.requestId);
      if (socket?.kind === "hmr") {
        socket.status = event.response.status;
        evidence.browser.hmrSocketStatuses.push({ route: socket.route, status: socket.status });
      } else if (socket?.kind === "preview") {
        socket.status = event.response.status;
        evidence.browser.webSocketHandshakes.push({ route: socket.route, status: socket.status });
      }
    });
    cdp.on("Network.webSocketFrameSent", event => {
      if (socketKinds.get(event.requestId)?.kind !== "rpc") return;
      for (const frame of parseFrames(event.response.payloadData)) {
        if (typeof frame.method !== "string") continue;
        evidence.rpcMethods.push(frame.method);
        if (FORBIDDEN_RPC.test(frame.method)) evidence.forbiddenRpcMethods.push(frame.method);
        if ((frame.method === "initialize" || frame.method === "runtime.workspaces.list" || frame.method === "runtime.worktrees.list") &&
            (typeof frame.id === "string" || typeof frame.id === "number")) {
          rpcRequests.set(String(event.requestId) + ":" + typeof frame.id + ":" + frame.id, frame.method);
        }
      }
    });
    cdp.on("Network.webSocketFrameReceived", event => {
      if (socketKinds.get(event.requestId)?.kind !== "rpc") return;
      for (const frame of parseFrames(event.response.payloadData)) {
        if (typeof frame.id !== "string" && typeof frame.id !== "number") continue;
        const requestKey = String(event.requestId) + ":" + typeof frame.id + ":" + frame.id;
        const method = rpcRequests.get(requestKey);
        if (!method) continue;
        const errorCode = Number.isInteger(frame.error?.code) ? frame.error.code : null;
        const result = frame.result;
        const itemCount = method !== "initialize" && Array.isArray(result?.items) ? result.items.length : null;
        evidence.rpcResponses.push({ method, success: errorCode === null && Object.hasOwn(frame, "result"), errorCode, itemCount });
        rpcRequests.delete(requestKey);
      }
    });
    page.on("request", request => {
      if (request.method() !== "POST") return;
      try {
        const url = new URL(request.url());
        if (url.origin === ORIGIN && /\/api\/mobile\/session\/refresh$/.test(url.pathname)) {
          evidence.forbiddenRpcMethods.push("HTTP POST mobile-session-refresh");
        }
      } catch { /* Keep request evidence route-only. */ }
    });

    stage = "mobile-pairing";
    const pairingResponse = page.waitForResponse(response => {
      try {
        const url = new URL(response.url());
        return response.request().method() === "POST" && url.origin === ORIGIN && url.pathname === `${link.prefix}/api/mobile/session`;
      } catch { return false; }
    }, { timeout: 25_000 }).then(async response => {
      evidence.pairing.status = response.status();
      if (!response.ok()) return false;
      const payload = await response.json();
      for (const key of ["accessToken", "rpcToken", "refreshToken"]) registerSecret(run, payload?.[key]);
      const initialServers = payload?.initialServers;
      evidence.apiServerInventory = {
        source: "POST /api/mobile/session response.initialServers",
        status: response.status(),
        version: Number.isInteger(initialServers?.version) ? initialServers.version : null,
        targets: safeTargetInventory(initialServers?.servers),
      };
      mobileAccessToken = typeof payload?.accessToken === "string" ? payload.accessToken : null;
      if (mobileAccessToken) run.addCleanup("revoke only this diagnostic Mobile device", revokeOwnDevice);
      return Boolean(mobileAccessToken);
    }).catch(error => {
      evidence.pairing.status ??= error?.name === "TimeoutError" ? "timeout" : "response-error";
      return false;
    });
    const pageResponse = await page.goto(link.connectUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    evidence.browser.pageStatus = pageResponse?.status() ?? null;
    const paired = await pairingResponse;
    if (!paired) throw new Error("mobile-pairing-not-established");
    await page.waitForFunction(() => {
      const query = new URLSearchParams(location.search);
      return !query.has("token") && !location.hash.startsWith("#token=");
    }, null, { timeout: 8_000, polling: 50 });
    evidence.pairing.addressCredentialFreeAfterPairing = await page.evaluate(() => {
      const query = new URLSearchParams(location.search);
      return !query.has("token") && !location.hash.startsWith("#token=");
    });

    stage = "home-readonly-load";
    const firstServerRow = page.locator('[data-testid^="home-workspace-row-"]').first();
    await firstServerRow.waitFor({ state: "visible", timeout: 30_000 });
    await firstServerRow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const home = await page.evaluate(() => {
      const bounds = item => {
        const rect = item.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      const rows = [...document.querySelectorAll('[data-testid^="home-workspace-row-"]')]
        .filter(row => {
          const style = getComputedStyle(row);
          const rect = row.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        })
        .map(container => {
          const toggle = container.querySelector('[data-testid^="toggle-server-"], [data-testid^="toggle-workspace-"]');
          const workspaceRow = toggle?.parentElement;
          if (!toggle || !workspaceRow) return null;
          const rowTestIds = [...workspaceRow.querySelectorAll("[data-testid]")].map(item => item.getAttribute("data-testid"));
          const actions = rowTestIds.filter(testId => testId.startsWith("workspace-actions-"));
          const plus = rowTestIds.filter(testId => testId.startsWith("new-workspace-"));
          const toggles = rowTestIds.filter(testId => testId.startsWith("toggle-server-") || testId.startsWith("toggle-workspace-"));
          return {
            containerTestId: container.getAttribute("data-testid"),
            toggleTestId: toggle.getAttribute("data-testid"),
            workspaceRowText: workspaceRow.innerText?.trim() ?? "",
            workspaceRowTestIds: rowTestIds,
            toggleCount: toggles.length,
            moreActionCount: actions.length,
            moreActionTestId: actions[0] ?? null,
            plusActionCount: plus.length,
            plusActionTestId: plus[0] ?? null,
            threadDescendantCount: workspaceRow.querySelectorAll('[data-testid^="thread-"]').length,
            bounds: bounds(workspaceRow),
          };
        }).filter(Boolean);
      return {
        rows,
        viewport: { width: innerWidth, height: innerHeight },
        path: location.pathname,
        queryKeys: [...new URLSearchParams(location.search).keys()].sort(),
        hashPresent: Boolean(location.hash),
      };
    });
    assert.ok(home?.rows.length > 0, "Home must render at least one real workspace row");
    assert.ok(home.rows.every(row => row.threadDescendantCount === 0), "workspace row selector must exclude thread-history descendants");
    assert.ok(home.rows.every(row => row.toggleCount === 1 && row.moreActionCount === 1 && row.plusActionCount === 1),
      "each captured workspace row must contain exactly its toggle, More action, and Plus action");
    assert.ok(evidence.apiServerInventory.targets.length > 0, "the pair bootstrap or a live /api/servers GET must identify a real target");
    evidence.home.workspaceRows = home.rows.map(({ containerTestId, toggleTestId, workspaceRowText, workspaceRowTestIds, toggleCount, moreActionCount, moreActionTestId, plusActionCount, plusActionTestId, threadDescendantCount }) => {
      const target = evidence.apiServerInventory.targets.find(item => item.id && containerTestId.startsWith("home-workspace-row-" + item.id + "-"));
      return {
        containerTestId,
        toggleTestId,
        workspaceRowText,
        workspaceRowTestIds,
        toggleCount,
        moreActionCount,
        moreActionTestId,
        plusActionCount,
        plusActionTestId,
        threadDescendantCount,
        targetId: target?.id ?? null,
        targetLabelFromApiServers: target?.label ?? null,
        targetConfiguredWorkspacePathFromApiServers: target?.workspacePath ?? null,
      };
    });
    evidence.browser.homeMounted = /\/mobile\/h\/[^/]+\/?$/.test(home.path);
    evidence.browser.addressCredentialFree = !home.queryKeys.includes("token") && !home.hashPresent;
    evidence.browser.hmrBundleLoaded = evidence.browser.entryScripts.some(item => item.status === 200 && /\.(?:bundle|js|mjs)$/.test(item.route));
    evidence.pairing.profileReady = evidence.browser.homeMounted;
    if (evidence.forbiddenRpcMethods.length > 0) throw new Error("unexpected-write-method-observed");
    assert.ok(evidence.browser.addressCredentialFree, "Home address must not contain pairing credentials");
    const requiredRpcResponses = ["initialize", "runtime.workspaces.list", "runtime.worktrees.list"];
    const missingRequiredRpcResponses = () => {
      const successful = new Set(evidence.rpcResponses.filter(item => item.success).map(item => item.method));
      return requiredRpcResponses.filter(method => !successful.has(method));
    };
    stage = "home-readonly-rpc-wait";
    try {
      await waitFor(
        () => missingRequiredRpcResponses().length === 0,
        30_000,
        "Home initialize and workspace/worktree listing RPCs",
        50,
        run.abortSignal,
      );
    } catch (error) {
      evidence.missingRpcResponses = missingRequiredRpcResponses();
      throw error;
    }
    evidence.missingRpcResponses = missingRequiredRpcResponses();
    assert.equal(evidence.missingRpcResponses.length, 0, "the preview Home must complete the expected read-only RPC listing");
    assert.ok(evidence.browser.hmrBundleLoaded, "the actual preview Home must load its Metro bundle");

    stage = "actual-preview-screenshot";
    for (let index = 0; index < home.rows.length; index += 1) {
      const row = home.rows[index];
      assert.match(row.toggleTestId, /^[A-Za-z0-9._-]+$/, "toggle test id must be safe for exact test-id lookup");
      const rowLocator = page.getByTestId(row.toggleTestId).locator("xpath=..");
      assert.equal(await rowLocator.locator('[data-testid^="thread-"]').count(), 0, "screenshot selector must contain no thread-history descendants");
      assert.equal(await rowLocator.locator('[data-testid^="toggle-server-"], [data-testid^="toggle-workspace-"]').count(), 1,
        "screenshot selector must be the toggle's direct parent and contain one toggle");
      assert.equal(await rowLocator.locator('[data-testid^="workspace-actions-"]').count(), 1, "workspace row must include More");
      assert.equal(await rowLocator.locator('[data-testid^="new-workspace-"]').count(), 1, "workspace row must include Plus");
      const screenshotName = "actual-preview-workspace-row-" + (index + 1) + ".png";
      await rowLocator.screenshot({ path: run.pathInArtifacts(screenshotName) });
      evidence.screenshots.push(screenshotName);
    }
    const sourceAfterScreenshot = await fingerprintProductSource();
    evidence.capture.timestamp = new Date().toISOString();
    evidence.capture.productFilesAfterScreenshot = sourceAfterScreenshot.files;
    evidence.capture.productAggregateSha256AfterScreenshot = sourceAfterScreenshot.aggregateSha256;
    evidence.capture.sourceStableDuringCapture = sourceAtStart.aggregateSha256 === sourceAfterScreenshot.aggregateSha256;
    assert.equal(evidence.capture.sourceStableDuringCapture, true, "Home/projection/parser source changed during preview capture");

  } catch (error) {
    evidence.failureStage = stage;
    evidence.failureKind = error?.message === "gateway-login-not-established"
      ? "gateway-login-rejected"
      : error?.message === "mobile-pairing-not-established"
        ? "mobile-pairing-failed-or-timed-out"
        : error?.message === "unexpected-write-method-observed"
          ? "unexpected-write-method-observed"
          : error?.name === "TimeoutError"
            ? "timeout"
            : "diagnostic-step-failed";
    evidence.failureStatus = stage === "gateway-login" ? evidence.login.status : stage === "mobile-pairing" ? evidence.pairing.status : null;
  } finally {
    await revokeOwnDevice();
    await cdp?.detach().catch(() => undefined);
    await closeContext();
    await logoutOwnGatewaySession();
    evidence.apiRoutes = [...apiRouteMap.values()];
    evidence.rpcMethods = [...new Set(evidence.rpcMethods)].sort();
    evidence.forbiddenRpcMethods = [...new Set(evidence.forbiddenRpcMethods)].sort();
    evidence.durationMs = Date.now() - startedAt;
    await run.writeArtifactJson("actual-preview-home-observation.json", evidence);
  }

  if (!evidence.screenshots.length || evidence.cleanup.deviceOutcome !== "own-device-revoked" || evidence.cleanup.gatewayLogoutStatus !== 303) {
    throw new Error("preview-home-before-acceptance-incomplete");
  }
  return {
    homeMounted: evidence.browser.homeMounted,
    apiTargets: evidence.apiServerInventory.targets,
    workspaceRows: evidence.home.workspaceRows.length,
    screenshot: evidence.screenshots[0],
    deviceRevoked: evidence.cleanup.deviceOutcome === "own-device-revoked",
    gatewayLoggedOut: evidence.cleanup.gatewayLogoutStatus === 303,
  };
});
