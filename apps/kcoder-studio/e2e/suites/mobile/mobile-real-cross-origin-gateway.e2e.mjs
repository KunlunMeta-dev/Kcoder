import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
const execFileAsync = promisify(execFile);
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-cross-origin-second-gateway",
  tier: "full-integration",
  modelPolicy: "model-independent real browser CORS boundary",
  retainSuccessLogs: true,
}, async context => {
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const makeGateway = async (suffix, options = {}) => {
    const workspace = context.pathInState(`workspace-${suffix}`);
    const configDir = context.pathInState(`config-${suffix}`);
    const providerId = `cross-${suffix}`;
    let settingsFile = context.pathInState(`settings-${suffix}.json`);
    let serversFile = context.pathInState(`servers-${suffix}.json`);
    if (!options.reuse) {
      await mkdir(workspace, { recursive: true });
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      settingsFile = await context.writeStateJson(`settings-${suffix}.json`, {
        active_provider: providerId,
        permission_mode: "yolo",
        providers: { [providerId]: provider(model.baseUrl, `cross-model-${suffix}`) },
      });
      await context.writeStateJson(`config-${suffix}/settings.json`, {});
      await context.writeStateJson(`config-${suffix}/credentials.json`, { [providerId]: { type: "api", key: "deterministic-local" } });
      serversFile = await context.writeStateJson(`servers-${suffix}.json`, [{
        id: "local", label: `Local ${suffix.toUpperCase()}`, transport: "local",
        command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile,
      }]);
    }
    return startGateway(context, {
      auth: true, label: options.label ?? `mobile-cross-origin-gateway-${suffix}`, workspace, serversFile,
      port: options.port, authToken: options.authToken,
      env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist, ...options.env },
    });
  };
  const gatewayA = await makeGateway("a");
  const gatewayB = await makeGateway("b");
  let trustedGatewayB = null;
  const isBHttpUrl = url => url.startsWith(gatewayB.baseUrl) || Boolean(trustedGatewayB && url.startsWith(trustedGatewayB.baseUrl));
  const isBWebSocketUrl = url => url.startsWith(gatewayB.baseUrl.replace(/^http/, "ws")) || Boolean(trustedGatewayB && url.startsWith(trustedGatewayB.baseUrl.replace(/^http/, "ws")));
  assert.notEqual(gatewayA.port, gatewayB.port);
  const chromium = await startChromium(context, { label: "mobile-cross-origin-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const consoleMessages = [];
  const failedRequests = [];
  const bRequests = [];
  const bResponses = [];
  const bCdpRequests = [];
  const bCdpResponses = [];
  const bCdpFailures = [];
  const bWebSockets = [];
  let trustedAttemptStartedAt = null;
  const bWebSocketUrls = new Map();
  const bRequestIds = new Set();
  cdp.on("Network.requestWillBeSent", event => {
    if (!isBHttpUrl(event.request.url)) return;
    bRequestIds.add(event.requestId);
    bCdpRequests.push({
      requestId: event.requestId,
      method: event.request.method,
      url: event.request.url,
      type: event.type,
      initiatorType: event.initiator?.type,
      origin: event.request.headers?.Origin,
      referer: event.request.headers?.Referer,
    });
  });
  cdp.on("Network.responseReceived", event => {
    if (!bRequestIds.has(event.requestId)) return;
    bCdpResponses.push({
      requestId: event.requestId,
      url: event.response.url,
      status: event.response.status,
      type: event.type,
      accessControlAllowOrigin: event.response.headers?.["access-control-allow-origin"],
      accessControlAllowMethods: event.response.headers?.["access-control-allow-methods"],
    });
  });
  cdp.on("Network.loadingFailed", event => {
    if (!bRequestIds.has(event.requestId)) return;
    bCdpFailures.push({
      requestId: event.requestId,
      errorText: event.errorText,
      blockedReason: event.blockedReason,
      corsErrorStatus: event.corsErrorStatus,
    });
  });
  cdp.on("Network.webSocketCreated", event => {
    if (isBWebSocketUrl(event.url)) bWebSocketUrls.set(event.requestId, event.url);
  });
  cdp.on("Network.webSocketWillSendHandshakeRequest", event => {
    const url = bWebSocketUrls.get(event.requestId);
    if (!url) return;
    bWebSockets.push({ requestId: event.requestId, url, requestProtocols: event.request.headers?.["Sec-WebSocket-Protocol"] });
  });
  cdp.on("Network.webSocketHandshakeResponseReceived", event => {
    const socket = bWebSockets.find(candidate => candidate.requestId === event.requestId);
    if (socket) Object.assign(socket, { status: event.response.status, responseProtocol: event.response.headers?.["Sec-WebSocket-Protocol"] });
  });
  page.on("console", message => { if (["error", "warning"].includes(message.type())) consoleMessages.push(`${message.type()}: ${message.text()}`); });
  page.on("request", request => { if (isBHttpUrl(request.url())) bRequests.push({ method: request.method(), url: request.url(), elapsedMs: trustedAttemptStartedAt ? Date.now() - trustedAttemptStartedAt : null, headers: request.headers() }); });
  page.on("response", response => { if (isBHttpUrl(response.url())) bResponses.push({ method: response.request().method(), url: response.url(), status: response.status(), elapsedMs: trustedAttemptStartedAt ? Date.now() - trustedAttemptStartedAt : null, headers: response.headers() }); });
  page.on("requestfailed", request => { if (isBHttpUrl(request.url())) failedRequests.push({ method: request.method(), url: request.url(), error: request.failure()?.errorText }); });

  await page.goto(gatewayA.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gatewayA.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gatewayA.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  const bundleSources = await page.locator('script[src*="/_expo/static/js/web/entry-"]').evaluateAll(
    nodes => nodes.map(node => node.getAttribute("src")).filter(Boolean),
  );
  assert.equal(bundleSources.length, 1, "必须运行当前 Mobile Web bundle");
  assert.match(page.url(), new RegExp(`^${gatewayA.baseUrl.replaceAll(".", "\\.")}/h/`));
  const profileA = profileFromUrl(page.url());

  const taskA = await createTask(page, "MULTI_PROFILE_SHARED_TITLE");
  await page.locator('[data-testid="message-input"]:visible').fill("ONLY_A_DRAFT");
  await openDrawerSettings(page);

  await page.getByText("添加 Gateway", { exact: true }).and(page.locator(":visible")).click();
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gatewayB.baseUrl);
  await page.getByTestId("gateway-token").fill(gatewayB.authToken);
  await page.getByTestId("gateway-connect").click();
  const error = page.getByText("无法访问 Gateway，请检查地址、网络和防火墙设置", { exact: true });
  await error.waitFor({ state: "visible", timeout: 30_000 });
  assert.ok(bRequests.some(request => request.method === "OPTIONS" || request.method === "POST"));
  assert.ok(bCdpRequests.some(request => request.method === "OPTIONS"), "CDP 应捕获真实 OPTIONS preflight");
  assert.ok(failedRequests.length > 0 || bResponses.some(response => response.status >= 400));
  assert.equal(page.url().startsWith(gatewayA.baseUrl), true, "失败后仍应停留在 A origin");
  const failureArtifact = {
    gatewayA: { baseUrl: gatewayA.baseUrl, sameOriginConnected: true },
    gatewayB: { baseUrl: gatewayB.baseUrl, crossOriginUiConnectFailed: true },
    bRequests, bResponses, failedRequests, bCdpRequests, bCdpResponses, bCdpFailures, consoleMessages,
    body: (await page.locator("body").innerText()).slice(0, 12_000),
  };
  await context.writeArtifactJson("mobile-real-cross-origin-gateway-failure.json", failureArtifact);

  trustedGatewayB = await makeGateway("btrusted", {
    label: "mobile-cross-origin-gateway-b-trusted",
    env: { KCODER_STUDIO_MOBILE_WEB_ORIGINS: gatewayA.baseUrl },
  });
  await page.getByTestId("gateway-endpoint").fill(trustedGatewayB.baseUrl);
  await page.getByTestId("gateway-token").fill(trustedGatewayB.authToken);
  await installNavigationTrace(page);
  trustedAttemptStartedAt = Date.now();
  await page.getByTestId("gateway-connect").click();
  const samples = await samplePageState(page, 5_000);
  const routedSamples = samples.filter(sample => /\/h\/[^/?]+$/.test(new URL(sample.url).pathname));
  const stableIndex = routedSamples.findIndex(sample => sample.stored?.activeId === profileFromUrl(sample.url));
  assert.ok(stableIndex >= 0, "B route 必须在采样期内提交 activeId");
  const stableSamples = routedSamples.slice(stableIndex);
  assert.ok(stableSamples.length >= 10);
  assert.ok(stableSamples.every(sample => sample.stored?.activeId === profileFromUrl(sample.url)), "activeId 提交 B 后不得再切回 A");
  assert.ok(stableSamples.slice(-10).every(sample => sample.visibleNewWorkspaceCount === 1 && sample.body.includes("会话")), "采样末尾 DOM 必须连续稳定");
  assert.ok(bRequests.filter(request => request.url === `${trustedGatewayB.baseUrl}/api/servers/status`).length <= 1, "B status 最多允许一组 in-flight refresh");
  const processSnapshot = await execFileAsync("ps", ["-eo", "pid,ppid,args"], { maxBuffer: 1024 * 1024 }).then(({ stdout }) => stdout.split("\n").filter(line => line.includes("settings-btrusted.json") || line.includes(String(trustedGatewayB.child.pid))));
  await context.writeArtifactJson("mobile-real-cross-origin-activation-trace.json", {
    samples,
    browserTrace: await page.evaluate(() => globalThis.__kcoderCrossOriginTrace ?? null),
    trustedGatewayPid: trustedGatewayB.child.pid,
    processSnapshot,
    statusRequests: bRequests.filter(request => request.url === `${trustedGatewayB.baseUrl}/api/servers/status`),
    statusResponses: bResponses.filter(response => response.url === `${trustedGatewayB.baseUrl}/api/servers/status`),
  });
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  const profileB = profileFromUrl(page.url());
  assert.notEqual(profileA, profileB);
  await context.writeArtifactJson("mobile-real-cross-origin-gateway-trusted-home.json", {
    url: page.url(), body: (await page.locator("body").innerText()).slice(0, 12_000),
    bRequests, bResponses, bCdpRequests, bCdpResponses, bCdpFailures,
  });

  const taskB = await createTask(page, "MULTI_PROFILE_SHARED_TITLE");
  await waitFor(() => bWebSockets.some(socket => socket.status === 101), 30_000, "B WebSocket 101");
  const trustedSocket = bWebSockets.find(socket => socket.status === 101);
  assert.match(trustedSocket?.requestProtocols ?? "", /^kcoder-studio, kcoder-session\.[A-Za-z0-9_-]+$/);
  const protocolSession = trustedSocket.requestProtocols.match(/kcoder-session\.([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(protocolSession, "B WebSocket 必须携带短期 session subprotocol");
  context.registerSecret(protocolSession);
  await page.locator('[data-testid="message-input"]:visible').fill("ONLY_B_DRAFT");
  await goToSettings(page);
  const profiles = await readProfiles(page);
  const storedA = profiles.find(profile => profile.id === profileA);
  const storedB = profiles.find(profile => profile.id === profileB);
  assert.equal(storedA?.baseUrl, gatewayA.baseUrl);
  assert.equal(storedB?.baseUrl, trustedGatewayB.baseUrl);

  await page.getByLabel(`切换到 ${storedA.label}`).and(page.locator(":visible")).click();
  await waitForStoredActiveProfile(page, profileA);
  const aThread = page.locator(`[data-testid="thread-${taskA.threadId}"]:visible`);
  await aThread.waitFor({ state: "visible", timeout: 30_000 });
  await aThread.click();
  const composer = page.locator('[data-testid="message-input"]:visible');
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await composer.inputValue(), "ONLY_A_DRAFT");
  await page.locator('[aria-label="打开任务列表"]:visible').click();
  const drawerCollapseA = page.locator('[data-testid="drawer-toggle-server-local"]:visible');
  assert.equal(await drawerCollapseA.getAttribute("aria-expanded"), "true");
  await drawerCollapseA.click();
  assert.equal(await drawerCollapseA.getAttribute("aria-expanded"), "false");
  await clickViewportDrawerSettings(page);
  await page.getByLabel(`切换到 ${storedB.label}`).and(page.locator(":visible")).click();
  await waitForStoredActiveProfile(page, profileB);
  const collapseB = page.locator('[data-testid="toggle-server-local"]:visible');
  await collapseB.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await collapseB.getAttribute("aria-expanded"), "true", "A 的折叠状态不得串到 B");
  await page.locator(`[data-testid="thread-${taskB.threadId}"]:visible`).click();
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await composer.inputValue(), "ONLY_B_DRAFT");

  await goToSettings(page);
  await page.getByLabel(`切换到 ${storedA.label}`).and(page.locator(":visible")).click();
  await waitForStoredActiveProfile(page, profileA);
  const collapseAAfterRoundtrip = page.locator('[data-testid="toggle-server-local"]:visible');
  await collapseAAfterRoundtrip.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await collapseAAfterRoundtrip.getAttribute("aria-expanded"), "false", "往返后 A 必须保持独立折叠状态");
  await goToSettings(page);
  await page.getByLabel(`切换到 ${storedB.label}`).and(page.locator(":visible")).click();
  await waitForStoredActiveProfile(page, profileB);
  await page.locator(`[data-testid="thread-${taskB.threadId}"]:visible`).waitFor({ state: "visible", timeout: 30_000 });

  await goToSettings(page);
  const confirmation = new Promise(resolveDialog => page.once("dialog", async dialog => { await dialog.accept(); resolveDialog(); }));
  await Promise.all([confirmation, clickViewportProfileRemove(page, gatewayA.baseUrl)]);
  await page.waitForFunction((removedUrl) => {
    try { return JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") ?? "null")?.profiles?.every(profile => profile.baseUrl !== removedUrl); }
    catch { return false; }
  }, gatewayA.baseUrl, { timeout: 10_000 });
  const reloadResponse = await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const reloadBody = (await page.locator("body").innerText()).slice(0, 12_000);
  const reloadCookies = (await page.context().cookies(gatewayA.baseUrl)).map(({ name, domain, path, expires, httpOnly, secure, sameSite }) => ({ name, domain, path, expires, httpOnly, secure, sameSite }));
  await context.writeArtifactJson("mobile-real-cross-origin-after-origin-profile-removal.json", {
    physicalOrigin: gatewayA.baseUrl,
    removedProfileId: profileA,
    survivingProfileId: profileB,
    reloadStatus: reloadResponse?.status(),
    reloadUrl: page.url(),
    reloadBody,
    originSessionMetadata: reloadCookies,
    storedProfiles: await page.evaluate(() => localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2")),
  });
  assert.equal(/KCoder Studio 登录|Access token|登录/.test(reloadBody), false, "删除物理 origin 对应 profile 后刷新不应退回 A Gateway 登录页");
  await waitForStoredActiveProfile(page, profileB);
  await page.waitForFunction((endpoint) => document.body?.innerText.includes(endpoint), trustedGatewayB.baseUrl, { timeout: 30_000 });
  const profilesAfterReload = await readProfiles(page);
  assert.deepEqual(profilesAfterReload.map(profile => profile.id), [profileB]);
  await clickViewportLabel(page, "返回");
  const reloadedBThread = page.locator(`[data-testid="thread-${taskB.threadId}"]:visible`);
  await reloadedBThread.waitFor({ state: "visible", timeout: 30_000 });
  await reloadedBThread.click();
  const reloadedComposer = page.locator('[data-testid="message-input"]:visible');
  await reloadedComposer.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await reloadedComposer.inputValue(), "ONLY_B_DRAFT", "刷新后 surviving B thread 与草稿必须仍可用");

  const gatewayC = await makeGateway("c");
  await page.goto(gatewayC.baseUrl, { waitUntil: "domcontentloaded" });
  const disallowed = await page.evaluate(async (url) => {
    try { const response = await fetch(`${url}/api/mobile/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); return { resolved: true, status: response.status }; }
    catch (error) { return { resolved: false, error: String(error) }; }
  }, trustedGatewayB.baseUrl);
  assert.equal(disallowed.resolved, false, "未列入 allow-list 的真实 Web origin 必须继续被浏览器拦截");

  await context.writeArtifactJson("mobile-real-cross-origin-gateway-success.json", {
    bundle: "entry-98ffc07db1e76210a7d373d00689b1c5.js",
    gateways: { a: gatewayA.baseUrl, bUntrusted: gatewayB.baseUrl, bTrusted: trustedGatewayB.baseUrl, c: gatewayC.baseUrl },
    profiles: { a: profileA, b: profileB, afterReload: profilesAfterReload },
    tasks: { a: taskA, b: taskB, sharedTitle: "MULTI_PROFILE_SHARED_TITLE" },
    trustedSocket,
    trustedStatusTiming: {
      requestCount: bRequests.filter(request => request.url === `${trustedGatewayB.baseUrl}/api/servers/status`).length,
      responses: bResponses.filter(response => response.url === `${trustedGatewayB.baseUrl}/api/servers/status`).map(response => ({ status: response.status, elapsedMs: response.elapsedMs })),
    },
    bCdpRequests, bCdpResponses, bCdpFailures, bWebSockets,
    profileIsolation: { aDraft: "ONLY_A_DRAFT", bDraft: "ONLY_B_DRAFT", collapseIsolated: true },
    nonCurrentRemovalSurvivedReload: true,
    survivingThreadUsableAfterReload: true,
    disallowedOrigin: { origin: gatewayC.baseUrl, result: disallowed },
  });
  return {
    sameOriginAConnected: true, crossOriginBFailedWithoutAllowList: true,
    crossOriginBConnectedWithAllowList: true, websocket101: true,
    profileIsolation: true, removeAndReload: true, disallowedOriginRejected: true,
  };
});

function provider(endpoint, model) {
  return { api_format: "openai_chat_completions", endpoint, default_model: model, context_window_tokens: 128000, output_headroom_tokens: 8192, max_output_tokens: 8192, request_timeout_secs: 30, no_proxy: true, extra_body: {} };
}

function profileFromUrl(url) {
  const id = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean)[1] ?? "");
  assert.ok(id, `URL 缺少 profileId: ${url}`);
  return id;
}

async function createTask(page, prompt) {
  const newWorkspace = page.locator('[data-testid="new-workspace-local"]:visible, [data-testid="new-workspace"]:visible').first();
  await newWorkspace.waitFor({ state: "visible", timeout: 30_000 });
  await newWorkspace.click({ force: true });
  await page.waitForURL(url => url.pathname === "/new", { timeout: 10_000 });
  const server = page.locator('[data-testid="server-option-local"]:visible');
  if (await server.count()) await server.click({ force: true });
  const promptInput = page.locator('[data-testid="new-workspace-prompt"]:visible');
  await promptInput.waitFor({ state: "visible", timeout: 30_000 });
  await promptInput.fill(prompt);
  const create = page.locator('[data-testid="create-workspace"]:visible');
  await create.waitFor({ state: "visible", timeout: 30_000 });
  await create.click();
  await page.locator('[data-testid="send-message"]:visible').waitFor({ state: "visible", timeout: 60_000 });
  const match = page.url().match(/\/task\/local\/([^/?]+)/);
  assert.ok(match?.[1], `新任务 URL 无 threadId: ${page.url()}`);
  return { threadId: decodeURIComponent(match[1]), url: page.url() };
}

async function goToSettings(page) {
  await openDrawerSettings(page);
  await page.getByText("添加 Gateway", { exact: true }).and(page.locator(":visible")).waitFor({ state: "visible", timeout: 10_000 });
}

async function openDrawerSettings(page) {
  const menu = page.locator('[aria-label="打开任务列表"]:visible, [aria-label="打开导航"]:visible');
  assert.equal(await menu.count(), 1, "当前 route 必须仅有一个可见导航入口");
  await menu.click();
  await page.waitForTimeout(100);
  await clickViewportDrawerSettings(page);
}

async function clickViewportDrawerSettings(page) {
  const hitCount = await page.locator('[data-testid="mobile-drawer"] [aria-label="设置"]').evaluateAll(elements => {
    const targets = elements.filter(element => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(x, y);
      return hit === element || Boolean(hit && element.contains(hit));
    });
    if (targets.length === 1) targets[0].click();
    return targets.length;
  });
  assert.equal(hitCount, 1, "当前 viewport 必须仅有一个可命中的抽屉设置入口");
}

async function clickViewportProfileRemove(page, baseUrl) {
  const hitCount = await page.locator("div").evaluateAll((elements, expectedUrl) => {
    const isHit = element => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
      const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)));
      return hit === element || Boolean(hit && element.contains(hit));
    };
    const buttons = [];
    for (const urlElement of elements.filter(element => element.textContent?.trim() === expectedUrl && isHit(element))) {
      let row = urlElement.parentElement;
      for (let depth = 0; row && depth < 4; depth += 1, row = row.parentElement) {
        const button = [...row.querySelectorAll('[role="button"]')].find(candidate => candidate.textContent?.trim() === "移除" && isHit(candidate));
        if (button) { buttons.push(button); break; }
      }
    }
    const unique = [...new Set(buttons)];
    if (unique.length === 1) unique[0].click();
    return unique.length;
  }, baseUrl);
  assert.equal(hitCount, 1, "当前 viewport 必须仅有一个可命中的目标 Gateway 移除按钮");
}

async function clickViewportLabel(page, label) {
  const hitCount = await page.locator(`[aria-label="${label}"]`).evaluateAll(elements => {
    const targets = elements.filter(element => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
      const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)));
      return hit === element || Boolean(hit && element.contains(hit));
    });
    if (targets.length === 1) targets[0].click();
    return targets.length;
  });
  assert.equal(hitCount, 1, `当前 viewport 必须仅有一个可命中的 ${label}`);
}

async function readProfiles(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") ?? "[]").profiles ?? JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") ?? "[]"));
}

async function waitForStoredActiveProfile(page, profileId) {
  await page.waitForFunction((expected) => {
    try { return JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") ?? "null")?.activeId === expected; }
    catch { return false; }
  }, profileId, { timeout: 10_000 });
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时: ${label}`);
}

async function installNavigationTrace(page) {
  await page.evaluate(() => {
    const startedAt = performance.now();
    const events = [];
    const record = (type, detail = {}) => events.push({ elapsedMs: Math.round(performance.now() - startedAt), type, url: location.href, ...detail });
    const describeWorkspace = node => node instanceof Element && (node.matches?.('[data-testid="new-workspace"]') || node.querySelector?.('[data-testid="new-workspace"]'));
    const observer = new MutationObserver(records => {
      for (const item of records) {
        for (const node of item.addedNodes) if (describeWorkspace(node)) record("new-workspace-added");
        for (const node of item.removedNodes) if (describeWorkspace(node)) record("new-workspace-removed");
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method].bind(history);
      history[method] = (...args) => { const result = original(...args); record(`history.${method}`, { target: String(args[2] ?? "") }); return result; };
    }
    addEventListener("popstate", () => record("popstate"));
    globalThis.__kcoderCrossOriginTrace = { events };
    record("installed");
  });
}

async function samplePageState(page, durationMs) {
  const samples = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    samples.push(await page.evaluate((elapsedMs) => {
      const raw = localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2");
      let stored = null;
      try { stored = raw ? JSON.parse(raw) : null; } catch {}
      return {
        elapsedMs,
        url: location.href,
        body: (document.body?.innerText ?? "").slice(0, 1000),
        newWorkspaceCount: document.querySelectorAll('[data-testid="new-workspace"]').length,
        visibleNewWorkspaceCount: [...document.querySelectorAll('[data-testid="new-workspace"]')].filter(element => element.getClientRects().length > 0).length,
        stored,
      };
    }, Date.now() - startedAt));
    await page.waitForTimeout(100);
  }
  return samples;
}
