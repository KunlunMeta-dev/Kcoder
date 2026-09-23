import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startFixtureSite } from "../../harness/fixture-site.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-browser-navigation-input-tabs-reload-close",
  tier: "full-integration",
  modelPolicy: "model-independent real browser protocol and lifecycle",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const site = await startFixtureSite(context, { title: "Mobile Real Browser", marker: "MOBILE_REAL_BROWSER_OK" });
  const gateway = await startGateway(context, {
    auth: true,
    label: "mobile-browser-gateway",
    workspace,
    env: {
      KCODER_STUDIO_SCENARIO: "full-turn",
      KCODER_STUDIO_WEB_ROOT: mobileDist,
      KCODER_CHROMIUM_BIN: process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium",
      KCODER_CHROMIUM_NO_SANDBOX: "1",
    },
  });
  const chromium = await startChromium(context, { label: "mobile-browser-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const rpcRequests = [];
  const rpcResponses = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`); });
  page.on("websocket", socket => {
    socket.on("framesent", event => { try { const value = JSON.parse(String(event.payload)); if (value?.method?.startsWith("browser/")) rpcRequests.push({ id: value.id, method: value.method, params: value.params ?? null }); } catch {} });
    socket.on("framereceived", event => { try { const value = JSON.parse(String(event.payload)); if (value?.id !== undefined && (value.result?.session_id || value.result?.page || value.result?.closed !== undefined)) rpcResponses.push({ id: value.id, result: value.result ?? null, error: value.error ?? null }); } catch {} });
  });
  await connect(page, gateway);
  await createTask(page, "MOBILE_REAL_BROWSER");

  await selectPanel(page, "browser-1");
  await openUrl(page, site.url);
  await waitForScreenshotTitle(page, rpcResponses, site.title);
  assert.equal(await page.getByTestId("browser-panel").getByLabel("后退", { exact: true }).isDisabled(), true);

  const popupUrl = new URL("/popup", site.url).href;
  await openUrl(page, popupUrl);
  await waitForScreenshotTitle(page, rpcResponses, `${site.title} Popup`);
  try {
    await waitForEnabled(page, activeBrowser(page).getByLabel("后退", { exact: true }));
  } catch (error) {
    await context.writeArtifactJson("browser-history-capability-failure.json", { rpcRequests, rpcResponses });
    throw error;
  }
  await page.getByTestId("browser-panel").getByLabel("后退", { exact: true }).click();
  await waitForInputValue(page, site.url);
  await waitForEnabled(page, activeBrowser(page).getByLabel("前进", { exact: true }));
  await page.getByTestId("browser-panel").getByLabel("前进", { exact: true }).click();
  await waitForInputValue(page, popupUrl);

  await page.getByTestId("workspace-add-panel").click();
  await page.getByText("启动一个独立远程浏览器", { exact: true }).click();
  await activeBrowser(page).waitFor({ state: "visible", timeout: 30_000 });
  await openUrl(page, site.url);
  await waitForCondition(page, () => rpcRequests.filter(request => request.method === "browser/start").length === 2);
  const startSessions = rpcResponses.filter(response => response.result?.session_id && response.result?.sandbox_disabled !== undefined).map(response => response.result.session_id);
  assert.equal(new Set(startSessions).size, 2, `两个浏览器标签必须使用不同 session：${JSON.stringify(startSessions)}`);

  await page.getByTestId("workspace-tab-switcher").click();
  const secondTab = page.getByRole("tab", { name: /浏览器 2/ });
  const secondPanelId = (await secondTab.getAttribute("data-testid"))?.replace("workspace-tab-", "");
  assert.ok(secondPanelId);
  await page.getByTestId("workspace-tab-browser-1").click();
  assert.equal(await activeBrowser(page).getByTestId("browser-url-input").inputValue(), popupUrl, "切回首个浏览器应保留独立历史位置");

  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId(`workspace-tab-${secondPanelId}`).click();
  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByLabel("关闭浏览器 2", { exact: true }).click();
  await waitForCondition(page, () => rpcRequests.filter(request => request.method === "browser/close").length >= 1);

  await page.getByTestId("workspace-tab-browser-1").click();
  const popupScreenshotsBeforeReload = rpcResponses.filter(response => response.result?.page?.title === `${site.title} Popup`).length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await activeBrowser(page).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await activeBrowser(page).getByTestId("browser-url-input").inputValue(), popupUrl, "刷新后应保留当前 URL");
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
  await activeBrowser(page).getByLabel("输入", { exact: true }).click();
  await waitForBrowserAction(page, rpcRequests, "text", request => request.params?.text === "OLD");
  await waitForCondition(page, async () => (await readInteractionState(site)).inputs.includes("OLD"));
  await activeBrowser(page).getByLabel("全选", { exact: true }).click();
  await waitForBrowserAction(page, rpcRequests, "shortcut", request => request.params?.key === "a");
  await activeBrowser(page).getByTestId("browser-keyboard-input").fill("MOBILE_TYPED_OKX");
  await activeBrowser(page).getByLabel("输入", { exact: true }).click();
  await waitForBrowserAction(page, rpcRequests, "text", request => request.params?.text === "MOBILE_TYPED_OKX");
  await waitForCondition(page, async () => (await readInteractionState(site)).inputs.includes("MOBILE_TYPED_OKX"));
  await activeBrowser(page).getByLabel("退格", { exact: true }).click();
  await waitForBrowserAction(page, rpcRequests, "key", request => request.params?.key === "Backspace");
  await waitForCondition(page, async () => (await readInteractionState(site)).inputs.includes("MOBILE_TYPED_OK"));
  await activeBrowser(page).getByLabel("回车", { exact: true }).click();
  await waitForBrowserAction(page, rpcRequests, "key", request => request.params?.key === "Enter");
  await waitForCondition(page, async () => (await readInteractionState(site)).submissions.includes("MOBILE_TYPED_OK"));

  await activeBrowser(page).getByLabel("Tab", { exact: true }).click();
  await waitForBrowserAction(page, rpcRequests, "key", request => request.params?.key === "Tab");
  await waitForCondition(page, async () => {
    const state = await readInteractionState(site);
    return state.keys.some(event => event.key === "Tab" && event.trusted === true)
      && state.focus.includes("probe-submit");
  });
  await activeBrowser(page).getByLabel("Escape", { exact: true }).click();
  await waitForBrowserAction(page, rpcRequests, "key", request => request.params?.key === "Escape");
  await waitForCondition(page, async () => (await readInteractionState(site)).keys.some(event =>
    event.key === "Escape" && event.trusted === true && event.active === "probe-submit"
  ));
  await activeBrowser(page).getByLabel("向下滚动", { exact: true }).click();
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

  assert.deepEqual(diagnostics, []);
  await context.writeArtifactJson("mobile-real-browser-lifecycle.json", { workspace, site: site.url, startSessions, interactionState, rpcRequests, rpcResponses, diagnostics });
  return { realAppServer: true, realChromium: true, navigationHistory: true, isolatedTabs: true, closeCleanup: true, urlReloadRestore: true, explicitSessionRestart: true, trustedCoordinateClick: true, remoteKeyboard: true, remoteWheel: true, mobileSwipeWheel: true };
});

function activeBrowser(page) { return page.locator('[data-testid="browser-panel"]:visible'); }

async function openUrl(page, url) {
  await activeBrowser(page).getByTestId("browser-url-input").fill(url);
  await activeBrowser(page).getByLabel("打开", { exact: true }).click();
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
  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId(`workspace-tab-${id}`).click();
  await activeBrowser(page).waitFor({ state: "visible", timeout: 30_000 });
}

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }), page.locator('button[type="submit"]').click()]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, prompt) {
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
}
