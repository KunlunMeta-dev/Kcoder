import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startFixtureSite } from "../../harness/fixture-site.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { buildGatewayMobileWebManifest, MOBILE_WEB_BASE_TOKEN, writeGatewayMobileWebManifest } from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { captureMobileRouteFailure, isExpectedMobileReloadSocketClose, observeMobileRuntimeInitialize } from "../../harness/mobile-runtime-initialize.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";

await runE2E(import.meta.url, {
  testId: "mobile-web-real-browser-navigation-input-tabs-reload-close",
  tier: "full-integration",
  modelPolicy: "model-independent real browser protocol and lifecycle",
  retainSuccessLogs: true,
}, async context => {
  const mobileWeb = await exportMobileWeb(context, {
    label: "mobile-browser-lifecycle-web-export",
    outputName: "mobile-web-export",
    dependencyRoot: resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"),
    deployMount: true,
  });
  const mobileDist = mobileWeb.path;
  const gatewayManifest = await buildGatewayMobileWebManifest(mobileDist, { expectedFiles: mobileWeb.bundleFiles });
  assert.deepEqual(gatewayManifest.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })), mobileWeb.bundleFiles);
  await writeGatewayMobileWebManifest(mobileDist, gatewayManifest);
  const gatewayManifestBytes = await readFile(resolve(mobileDist, "kcoder-mobile-web.json"));
  const gatewayManifestSha256 = createHash("sha256").update(gatewayManifestBytes).digest("hex");
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const site = await startFixtureSite(context, { title: "Mobile Real Browser", marker: "MOBILE_REAL_BROWSER_OK" });
  const gateway = await startGateway(context, {
    auth: true,
    label: "mobile-browser-gateway",
    workspace,
    env: {
      KCODER_STUDIO_SCENARIO: "full-turn",
      KCODER_STUDIO_WEB_ROOT: "",
      KCODER_STUDIO_MOBILE_WEB_ROOT: mobileDist,
      KCODER_CHROMIUM_BIN: process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium",
      KCODER_CHROMIUM_NO_SANDBOX: "1",
    },
  });
  await verifyMobileStaticEntry(context, gateway, mobileDist, mobileWeb, gatewayManifestSha256, gatewayManifest.files.length);
  const chromium = await startChromium(context, { label: "mobile-browser-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const diagnosticEvents = [];
  const expectedReloadSocketCloseWarnings = [];
  let reloadDiagnosticsPhase = "idle";
  const runtimeInitialize = observeMobileRuntimeInitialize(page, {
    gatewayBaseUrl: gateway.baseUrl,
    workspacePath: workspace,
    getPhase: () => reloadDiagnosticsPhase,
    redactText: value => context.redactText(value),
  });
  const rpcRequests = [];
  const rpcResponses = [];
  page.on("pageerror", error => {
    const message = context.redactText(error.message);
    diagnosticEvents.push({ phase: reloadDiagnosticsPhase, type: "pageerror", message, location: null });
    diagnostics.push(`pageerror: ${message}`);
  });
  page.on("console", message => {
    if (!["error", "warning"].includes(message.type())) return;
    const text = message.text();
    const location = message.location();
    const event = {
      phase: reloadDiagnosticsPhase,
      type: message.type(),
      message: context.redactText(text),
      location: { url: context.redactText(location.url || ""), lineNumber: location.lineNumber, columnNumber: location.columnNumber },
    };
    diagnosticEvents.push(event);
    const classifierInput = { kind: message.type(), phase: reloadDiagnosticsPhase, message: text };
    if (isExpectedMobileReloadSocketClose(classifierInput, { gatewayBaseUrl: gateway.baseUrl, workspacePath: workspace })) {
      expectedReloadSocketCloseWarnings.push({ phase: reloadDiagnosticsPhase, route: "local runtime RPC", workspaceMatches: true });
      return;
    }
    diagnostics.push(`${message.type()}: ${event.message}`);
  });
  page.on("websocket", socket => {
    socket.on("framesent", event => { try { const value = JSON.parse(String(event.payload)); if (value?.method?.startsWith("browser/")) rpcRequests.push({ id: value.id, method: value.method, params: value.params ?? null }); } catch {} });
    socket.on("framereceived", event => { try { const value = JSON.parse(String(event.payload)); if (value?.id !== undefined && (value.result?.session_id || value.result?.page || value.result?.closed !== undefined)) rpcResponses.push({ id: value.id, result: value.result ?? null, error: value.error ?? null }); } catch {} });
  });
  await connect(page, gateway);
  await createTask(page, "MOBILE_REAL_BROWSER", { context, runtimeInitialize, diagnosticEvents });

  await selectPanel(page, "browser-1");
  await openUrl(page, site.url);
  await waitForScreenshotTitle(page, rpcResponses, site.title);
  assert.equal(await page.getByTestId("browser-back").isDisabled(), true);

  const popupUrl = new URL("/popup", site.url).href;
  await openUrl(page, popupUrl);
  await waitForScreenshotTitle(page, rpcResponses, `${site.title} Popup`);
  try {
    await waitForEnabled(page, activeBrowser(page).getByTestId("browser-back"));
  } catch (error) {
    await context.writeArtifactJson("browser-history-capability-failure.json", { rpcRequests, rpcResponses });
    throw error;
  }
  await page.getByTestId("browser-back").click();
  await waitForInputValue(page, site.url);
  await waitForEnabled(page, activeBrowser(page).getByTestId("browser-forward"));
  await page.getByTestId("browser-forward").click();
  await waitForInputValue(page, popupUrl);

  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-workspace").click();
  await page.getByTestId("workspace-new-panel").click();
  await page.getByTestId("workspace-new-panel-option-browser").click();
  await activeBrowser(page).waitFor({ state: "visible", timeout: 30_000 });
  await openUrl(page, site.url);
  await waitForCondition(page, () => rpcRequests.filter(request => request.method === "browser/start").length === 2);
  const startSessions = rpcResponses.filter(response => response.result?.session_id && response.result?.sandbox_disabled !== undefined).map(response => response.result.session_id);
  assert.equal(new Set(startSessions).size, 2, `两个浏览器标签必须使用不同 session：${JSON.stringify(startSessions)}`);

  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-workspace").click();
  const secondTab = page.locator('[data-testid^="workspace-tab-browser-"]').nth(1);
  const secondPanelId = (await secondTab.getAttribute("data-testid"))?.replace("workspace-tab-", "");
  assert.ok(secondPanelId);
  await page.getByTestId("workspace-tab-browser-1").click();
  assert.equal(await activeBrowser(page).getByTestId("browser-url-input").inputValue(), popupUrl, "切回首个浏览器应保留独立历史位置");

  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-workspace").click();
  await page.getByTestId(`workspace-tab-${secondPanelId}`).click();
  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-workspace").click();
  await page.getByTestId(`workspace-close-panel-${secondPanelId}`).click();
  await waitForCondition(page, () => rpcRequests.filter(request => request.method === "browser/close").length >= 1);

  await page.getByTestId("workspace-tab-browser-1").click();
  const popupScreenshotsBeforeReload = rpcResponses.filter(response => response.result?.page?.title === `${site.title} Popup`).length;
  const successfulInitializationsBeforeReload = runtimeInitialize.successfulInitializations().length;
  reloadDiagnosticsPhase = "page-reload-restore";
  await page.reload({ waitUntil: "domcontentloaded" });
  await activeBrowser(page).waitFor({ state: "visible", timeout: 30_000 });
  let runtimeInitializeAfterReload;
  try {
    runtimeInitializeAfterReload = await runtimeInitialize.waitForSuccessfulInitializeAfter(successfulInitializationsBeforeReload);
    assert.equal(runtimeInitializeAfterReload.testPhaseAtSocket, "page-reload-restore", "刷新后的 initialize 必须来自重载阶段创建的 runtime socket");
    assert.equal(runtimeInitializeAfterReload.requestTestPhase, "page-reload-restore", "刷新后的 initialize 请求必须在重载阶段发出");
    assert.equal(runtimeInitializeAfterReload.testPhase, "page-reload-restore", "刷新后的 initialize 成功响应必须在重载阶段收到");
  } catch (error) {
    await context.writeArtifactJson("runtime-reload-initialize-failure.json", {
      expectedReloadSocketCloseWarnings,
      runtimeSocketObservations: runtimeInitialize.sockets,
      diagnostics,
      diagnosticEvents,
    });
    throw error;
  }
  assert.equal(await activeBrowser(page).getByTestId("browser-url-input").inputValue(), popupUrl, "刷新后应保留当前 URL");
  reloadDiagnosticsPhase = "post-reload-browser-actions";
  assert.equal(await activeBrowser(page).locator('img[src^="data:image/"]').count(), 0, "刷新后已关闭的进程截图不应冒充存活会话");
  await openUrl(page, popupUrl);
  await waitForCondition(page, () => rpcRequests.filter(request => request.method === "browser/start").length === 3);
  await waitForScreenshotTitle(page, rpcResponses, `${site.title} Popup`, popupScreenshotsBeforeReload + 1);

  await openUrl(page, site.interactionUrl);
  await waitForScreenshotTitle(page, rpcResponses, `${site.title} Interactions`);
  const interactionFrame = [...rpcResponses].reverse().find(response => response.result?.page?.title === `${site.title} Interactions` && typeof response.result?.data_base64 === "string")?.result;
  assert.ok(interactionFrame?.width > 0 && interactionFrame?.height > 0, "交互页必须返回可映射的真实截图尺寸");

  await clickRemotePoint(page, interactionFrame, { x: 120, y: 65 });
  await waitForCondition(page, async () => (await readInteractionState(site)).clickTrusted.includes(true));

  await clickRemotePoint(page, interactionFrame, { x: 150, y: 152 });
  await activeBrowser(page).getByTestId("browser-keyboard-input").fill("OLD");
  await activeBrowser(page).getByTestId("browser-send-text").click();
  await waitForBrowserAction(page, rpcRequests, "text", request => request.params?.text === "OLD");
  await waitForCondition(page, async () => (await readInteractionState(site)).inputs.includes("OLD"));
  await activeBrowser(page).getByTestId("browser-select-all").click();
  await waitForBrowserAction(page, rpcRequests, "shortcut", request => request.params?.key === "a");
  await activeBrowser(page).getByTestId("browser-keyboard-input").fill("MOBILE_TYPED_OKX");
  await activeBrowser(page).getByTestId("browser-send-text").click();
  await waitForBrowserAction(page, rpcRequests, "text", request => request.params?.text === "MOBILE_TYPED_OKX");
  await waitForCondition(page, async () => (await readInteractionState(site)).inputs.includes("MOBILE_TYPED_OKX"));
  await activeBrowser(page).getByTestId("browser-backspace").click();
  await waitForBrowserAction(page, rpcRequests, "key", request => request.params?.key === "Backspace");
  await waitForCondition(page, async () => (await readInteractionState(site)).inputs.includes("MOBILE_TYPED_OK"));
  await activeBrowser(page).getByTestId("browser-enter-key").click();
  await waitForBrowserAction(page, rpcRequests, "key", request => request.params?.key === "Enter");
  await waitForCondition(page, async () => (await readInteractionState(site)).submissions.includes("MOBILE_TYPED_OK"));

  await activeBrowser(page).getByTestId("browser-tab-key").click();
  await waitForBrowserAction(page, rpcRequests, "key", request => request.params?.key === "Tab");
  await waitForCondition(page, async () => {
    const state = await readInteractionState(site);
    return state.keys.some(event => event.key === "Tab" && event.trusted === true)
      && state.focus.includes("probe-submit");
  });
  await activeBrowser(page).getByTestId("browser-escape-key").click();
  await waitForBrowserAction(page, rpcRequests, "key", request => request.params?.key === "Escape");
  await waitForCondition(page, async () => (await readInteractionState(site)).keys.some(event =>
    event.key === "Escape" && event.trusted === true && event.active === "probe-submit"
  ));
  await activeBrowser(page).getByTestId("browser-scroll-down").click();
  await waitForBrowserAction(page, rpcRequests, "wheel", request => Number(request.params?.delta_y) > 0);
  await waitForCondition(page, async () => (await readInteractionState(site)).scrollY > 0);
  const buttonScrollState = await readInteractionState(site);
  const wheelCountBeforeSwipe = browserActionCount(rpcRequests, "wheel");
  const clickCountBeforeSwipe = browserActionCount(rpcRequests, "click");
  const pointerDownCountBeforeSwipe = browserActionCount(rpcRequests, "pointer_down");
  await swipeBrowserFrame(page);
  await waitForCondition(page, () => browserActionCount(rpcRequests, "wheel") > wheelCountBeforeSwipe);
  await waitForCondition(page, async () => (await readInteractionState(site)).scrollY > buttonScrollState.scrollY);
  assert.equal(browserActionCount(rpcRequests, "click"), clickCountBeforeSwipe, "垂直滑动不得误发远程 click");
  assert.equal(browserActionCount(rpcRequests, "pointer_down"), pointerDownCountBeforeSwipe, "垂直滑动不得误判为拖拽");
  const interactionState = await readInteractionState(site);

  await context.writeArtifactJson("mobile-real-browser-console-diagnostics.json", {
    diagnosticEvents,
    expectedReloadSocketCloseWarnings,
    runtimeSocketObservations: runtimeInitialize.sockets,
    diagnostics,
  });
  assert.ok(expectedReloadSocketCloseWarnings.length <= 1, "reload may emit at most one expected local RPC handshake-close warning");
  assert.deepEqual(diagnostics, []);
  await context.writeArtifactJson("mobile-real-browser-lifecycle.json", {
    workspace,
    site: site.url,
    mobileWebExport: { sourceTreeSha256: mobileWeb.sourceTreeSha256, bundleSha256: mobileWeb.bundleSha256, bundleFileCount: mobileWeb.bundleFileCount },
    runtimeInitializeAfterReload,
    runtimeSocketObservations: runtimeInitialize.sockets,
    startSessions,
    interactionState,
    rpcRequests,
    rpcResponses,
    expectedReloadSocketCloseWarnings,
    diagnostics,
  });
  return {
    realAppServer: true,
    realChromium: true,
    navigationHistory: true,
    isolatedTabs: true,
    closeCleanup: true,
    urlReloadRestore: true,
    runtimeInitializeAfterReload: runtimeInitializeAfterReload.protocolVersion,
    expectedReloadSocketCloseWarnings: expectedReloadSocketCloseWarnings.length,
    mobileSourceTreeSha256: mobileWeb.sourceTreeSha256,
    mobileBundleSha256: mobileWeb.bundleSha256,
    explicitSessionRestart: true,
    trustedCoordinateClick: true,
    remoteKeyboard: true,
    remoteWheel: true,
    mobileSwipeWheel: true,
  };
});

function activeBrowser(page) { return page.locator('[data-testid="browser-panel"]:visible'); }

async function openUrl(page, url) {
  await activeBrowser(page).getByTestId("browser-url-input").fill(url);
  await activeBrowser(page).getByTestId("browser-open").click();
  await activeBrowser(page).locator('img[src^="data:image/"]').waitFor({ state: "visible", timeout: 60_000 });
}

async function waitForInputValue(page, expected) {
  await page.waitForFunction(value => document.querySelector('[data-testid="browser-panel"]:not([aria-hidden="true"]) [data-testid="browser-url-input"]')?.value === value
    || [...document.querySelectorAll('[data-testid="browser-url-input"]')].some(input => input.offsetWidth > 0 && input.value === value), expected, { timeout: 30_000 });
}

async function waitForScreenshotTitle(page, responses, title, minimum = 1) {
  await waitForCondition(page, () => responses.filter(response => response.result?.page?.title === title && typeof response.result?.data_base64 === "string").length >= minimum);
}

async function waitForCondition(page, condition) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > 60_000) throw new Error("等待真实浏览器协议事件超时");
    await page.waitForTimeout(100);
  }
}

async function waitForEnabled(page, locator) {
  await waitForCondition(page, async () => !(await locator.isDisabled()));
}

async function clickRemotePoint(page, frame, point) {
  const box = await activeBrowser(page).getByTestId("browser-frame").boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "远程浏览器截图区域必须可见");
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const offsetX = (box.width - frame.width * scale) / 2;
  const offsetY = (box.height - frame.height * scale) / 2;
  await page.mouse.click(box.x + offsetX + point.x * scale, box.y + offsetY + point.y * scale);
}

async function swipeBrowserFrame(page) {
  const box = await activeBrowser(page).getByTestId("browser-frame").boundingBox();
  assert.ok(box && box.width > 0 && box.height > 200, "远程浏览器截图区域必须支持垂直滑动");
  const x = box.x + box.width * 0.8;
  const startY = box.y + box.height * 0.72;
  await page.mouse.move(x, startY);
  await page.mouse.down();
  await page.mouse.move(x, startY - 90);
  await page.waitForTimeout(60);
  await page.mouse.move(x, startY - 180);
  await page.waitForTimeout(60);
  await page.mouse.up();
}

function browserActionCount(requests, action) {
  return requests.filter(request => request.method === "browser/action" && request.params?.action === action).length;
}

async function waitForBrowserAction(page, requests, action, predicate = () => true) {
  await waitForCondition(page, () => requests.some(request =>
    request.method === "browser/action" && request.params?.action === action && predicate(request)
  ));
}

async function readInteractionState(site) {
  const response = await fetch(site.interactionStateUrl, { cache: "no-store" });
  assert.equal(response.status, 200);
  return response.json();
}

async function selectPanel(page, id) {
  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-workspace").click();
  await page.getByTestId(`workspace-tab-${id}`).click();
  await activeBrowser(page).waitFor({ state: "visible", timeout: 30_000 });
}

async function connect(page, gateway) {
  await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, prompt, failureCapture) {
  await page.getByTestId("new-workspace").click();
  try {
    await page.getByTestId("new-task-draft").waitFor({ state: "visible", timeout: 30_000 });
  } catch (error) {
    try {
      await captureMobileRouteFailure(page, {
        context: failureCapture.context,
        artifactName: "new-task-draft-wait-failure.json",
        screenshotName: "new-task-draft-wait-failure.png",
        testPhase: "create-task-after-home-new",
        testIds: [
          "new-workspace", "new-task-draft", "new-task-advanced", "server-option-local",
          "workspace-path", "new-workspace-prompt", "create-workspace", "welcome-direct-connection",
          "gateway-connect", "new-workspace-error", "workspace-task-handoff-error",
        ],
        diagnosticEvents: failureCapture.diagnosticEvents,
        runtimeSocketObservations: failureCapture.runtimeInitialize.sockets,
        error,
      });
    }
    catch { /* Preserve the original locator timeout if failure evidence cannot be written. */ }
    throw error;
  }
  await page.getByTestId("new-task-advanced").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
}

async function verifyMobileStaticEntry(context, gateway, mobileDist, mobileWeb, gatewayManifestSha256, gatewayManifestResourceCount) {
  const entry = mobileWeb.bundleFiles.find(file => file.path.startsWith("_expo/static/js/web/entry-") && file.path.endsWith(".js"));
  assert.ok(entry, "current Mobile Web export must include its Expo web entry chunk");
  const exportedBytes = await readFile(resolve(mobileDist, entry.path));
  assert.equal(createHash("sha256").update(exportedBytes).digest("hex"), entry.sha256, "entry bytes must match the exporter inventory");
  const expectedMountedBytes = Buffer.from(exportedBytes.toString("utf8").replaceAll(MOBILE_WEB_BASE_TOKEN, "/mobile"));
  const expectedMountedSha256 = createHash("sha256").update(expectedMountedBytes).digest("hex");
  const response = await fetch(new URL(`/mobile/${entry.path}`, gateway.baseUrl));
  const servedBytes = Buffer.from(await response.arrayBuffer());
  const servedSha256 = createHash("sha256").update(servedBytes).digest("hex");
  assert.equal(response.status, 200, "Gateway Mobile mount must serve the current export entry");
  assert.equal(servedSha256, expectedMountedSha256, "Gateway Mobile entry must match the deploy-base transformed current export");
  await context.writeArtifactJson("mobile-web-mounted-entry.json", {
    path: entry.path,
    status: response.status,
    exportSha256: entry.sha256,
    expectedMountedSha256,
    servedSha256,
    matchesDeployTransform: true,
    gatewayManifestSha256,
    gatewayManifestResourceCount,
  });
}
