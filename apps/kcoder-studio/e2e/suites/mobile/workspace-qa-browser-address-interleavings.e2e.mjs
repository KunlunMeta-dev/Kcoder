import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startFixtureSite } from "../../harness/fixture-site.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(process.env.KCODER_E2E_MOBILE_WEB_ROOT || resolve(appRoot, "mobile/dist"));
const viewportWidth = Number(process.env.KCODER_E2E_VIEWPORT_WIDTH || 390);
assert.ok([360, 390, 768].includes(viewportWidth), "KCODER_E2E_VIEWPORT_WIDTH must be 360, 390, or 768");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: `workspace-qa-browser-address-interleavings-${viewportWidth}`,
  tier: "full-integration",
  modelPolicy: "model-independent scenario task with real Gateway/app-server/browser RPC; one request held at the browser client boundary and released to the real server",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const oldSite = await startFixtureSite(context, { title: "Address Draft Old Page", marker: "ADDRESS_OLD_PAGE" });
  const newSite = await startFixtureSite(context, { title: "Address Draft New Page", marker: "ADDRESS_NEW_PAGE" });
  const gateway = await startGateway(context, {
    auth: true,
    label: "workspace-qa-browser-address-gateway",
    workspace,
    env: {
      KCODER_STUDIO_SCENARIO: "full-turn",
      KCODER_STUDIO_WEB_ROOT: mobileDist,
      KCODER_CHROMIUM_BIN: process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium",
      KCODER_CHROMIUM_NO_SANDBOX: "1",
    },
  });
  const chromium = await startChromium(context, { label: "workspace-qa-browser-address-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: viewportWidth, height: 844 });
  await installRpcHold(page);

  const diagnostics = [];
  const rpcRequests = [];
  const rpcResponses = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  page.on("websocket", socket => {
    const methods = new Map();
    socket.on("framesent", event => {
      try {
        const value = JSON.parse(String(event.payload));
        if (!value?.method?.startsWith("browser/")) return;
        const request = { id: value.id, method: value.method, params: value.params ?? null };
        rpcRequests.push(request);
        methods.set(value.id, request);
      } catch {}
    });
    socket.on("framereceived", event => {
      try {
        const value = JSON.parse(String(event.payload));
        if (value?.id === undefined || !methods.has(value.id)) return;
        const request = methods.get(value.id);
        const result = value.result ?? null;
        rpcResponses.push({
          id: value.id,
          method: request.method,
          action: request.params?.action ?? null,
          requestedUrl: request.params?.url ?? null,
          error: value.error ? { code: value.error.code, message: value.error.message } : null,
          page: result?.page ?? null,
          width: result?.width ?? null,
          height: result?.height ?? null,
          imageBytes: typeof result?.data_base64 === "string" ? result.data_base64.length : null,
        });
      } catch {}
    });
  });

  await connect(page, gateway);
  await createTask(page, "WORKSPACE_QA_BROWSER_ADDRESS");
  await selectPanel(page, "browser-1");
  await openUrl(page, oldSite.url);
  await waitForScreenshotTitle(page, rpcResponses, oldSite.title);

  const address = activeBrowser(page).getByTestId("browser-url-input");
  const oldScreenshotCount = screenshotCount(rpcResponses, oldSite.url);
  await address.fill(newSite.url);
  await address.press("Tab");
  await waitForCondition(page, () => screenshotCount(rpcResponses, oldSite.url) > oldScreenshotCount);
  await page.waitForTimeout(250);
  const blurValue = await address.inputValue();
  const blurDraftPreserved = blurValue === newSite.url;

  // Hold only the Go navigation frame at the real WebSocket send boundary. Poll screenshots
  // still travel to the real app-server and return the old page while this RPC is pending.
  const pendingScreenshotCount = screenshotCount(rpcResponses, oldSite.url);
  await address.fill(newSite.url);
  await page.evaluate(({ url }) => window.__workspaceQaRpcHoldNext("browser/action", { action: "navigate", url }), { url: newSite.url });
  await activeBrowser(page).getByLabel("打开", { exact: true }).click();
  await waitForHeldRpc(page, "browser/action", newSite.url);
  await waitForCondition(page, () => screenshotCount(rpcResponses, oldSite.url) > pendingScreenshotCount);
  await page.waitForTimeout(200);
  const pendingValue = await address.inputValue();
  const pendingDraftPreserved = pendingValue === newSite.url;
  const heldNavigation = await page.evaluate(url => {
    const held = window.__workspaceQaRpcHeld.find(item => item.message.method === "browser/action" && item.message.params?.url === url);
    return held ? { id: held.message.id, method: held.message.method, action: held.message.params.action, url: held.message.params.url } : null;
  }, newSite.url);
  assert.ok(heldNavigation, "test must hold the real browser/action navigate request");
  await page.evaluate(id => window.__workspaceQaRpcRelease(id), heldNavigation.id);
  await waitForScreenshotTitle(page, rpcResponses, newSite.title);
  await waitForInputValue(page, newSite.url);

  // The app-server rejects non-http(s) URLs. Keep the draft pending across an old-page poll,
  // then release it and verify the user can retry with a valid local fixture URL.
  const invalidUrl = "file:///etc/passwd";
  const currentScreenshotCount = screenshotCount(rpcResponses, newSite.url);
  await address.fill(invalidUrl);
  await address.press("Tab");
  await page.evaluate(({ url }) => window.__workspaceQaRpcHoldNext("browser/action", { action: "navigate", url }), { url: invalidUrl });
  await activeBrowser(page).getByLabel("打开", { exact: true }).click();
  await waitForHeldRpc(page, "browser/action", invalidUrl);
  await waitForCondition(page, () => screenshotCount(rpcResponses, newSite.url) > currentScreenshotCount);
  await page.waitForTimeout(200);
  const rejectedPendingValue = await address.inputValue();
  await page.evaluate(url => {
    const held = window.__workspaceQaRpcHeld.find(item => item.message.method === "browser/action" && item.message.params?.url === url);
    if (!held) throw new Error("missing held invalid navigation");
    window.__workspaceQaRpcRelease(held.message.id);
  }, invalidUrl);
  await page.getByText(/browser URL must be an http\(s\) URL without credentials/i).waitFor({ state: "visible", timeout: 30_000 });
  const rejectedValue = await address.inputValue();
  const rejectionResponse = rpcResponses.find(response => response.method === "browser/action" && response.error?.message?.includes("http(s) URL"));
  const retryOldScreenshotBaseline = screenshotCount(rpcResponses, oldSite.url);
  await address.fill(oldSite.url);
  await activeBrowser(page).getByLabel("打开", { exact: true }).click();
  await waitForCondition(page, () => screenshotCount(rpcResponses, oldSite.url) > retryOldScreenshotBaseline);
  await waitForInputValue(page, oldSite.url);
  // A rejected navigation closes that session. Re-open a local page in this fresh
  // session so the history boundary below is real and has a previous entry.
  const newScreenshotBaselineAfterRetry = screenshotCount(rpcResponses, newSite.url);
  await openUrl(page, newSite.url);
  await waitForCondition(page, () => screenshotCount(rpcResponses, newSite.url) > newScreenshotBaselineAfterRetry);
  await waitForInputValue(page, newSite.url);
  await waitForEnabled(page, activeBrowser(page).getByLabel("后退", { exact: true }));

  const backDraftBeforeAction = "http://draft-before-back.invalid/";
  const backDraftDuringAction = "http://draft-during-back.invalid/";
  await address.fill(backDraftBeforeAction);
  await address.press("Tab");
  const backScreenshotBaseline = screenshotCount(rpcResponses, newSite.url);
  await page.evaluate(() => window.__workspaceQaRpcHoldNext("browser/action", { action: "back" }));
  await activeBrowser(page).getByLabel("后退", { exact: true }).click();
  await waitForHeldAction(page, "back");
  await address.fill(backDraftDuringAction);
  await address.press("Tab");
  await waitForCondition(page, () => screenshotCount(rpcResponses, newSite.url) > backScreenshotBaseline);
  const draftPreservedDuringBackPoll = (await address.inputValue()) === backDraftDuringAction;
  const heldBack = await page.evaluate(() => {
    const held = window.__workspaceQaRpcHeld.find(item => item.message.method === "browser/action" && item.message.params?.action === "back");
    return held ? { id: held.message.id, action: held.message.params.action } : null;
  });
  assert.ok(heldBack, "test must hold the real browser Back action");
  const oldTitleBeforeBack = rpcResponses.filter(response => response.method === "browser/screenshot" && response.page?.title === oldSite.title).length;
  await page.evaluate(id => window.__workspaceQaRpcRelease(id), heldBack.id);
  await waitForCondition(page, () => rpcResponses.some(response => response.method === "browser/action" && response.action === "back" && response.page?.url === oldSite.url));
  await waitForScreenshotTitle(page, rpcResponses, oldSite.title, oldTitleBeforeBack + 1);
  await page.waitForTimeout(250);
  const backActionDraftRetained = (await address.inputValue()) === backDraftDuringAction;

  // Delay a genuine old-page screenshot response until after Forward reports its
  // authoritative page URL. This forces the stale frame to arrive out of order.
  const forwardPriorDraft = "http://draft-before-forward.invalid/";
  await address.fill(forwardPriorDraft);
  await address.press("Tab");
  await page.evaluate(url => window.__workspaceQaRpcHoldNextResponse("browser/screenshot", url), oldSite.url);
  await waitForHeldResponse(page, "browser/screenshot", oldSite.url);
  const heldStaleForwardScreenshot = await page.evaluate(url => {
    const held = window.__workspaceQaRpcHeldResponses.find(item => item.method === "browser/screenshot" && item.pageUrl === url);
    return held ? { id: held.id, method: held.method, pageUrl: held.pageUrl } : null;
  }, oldSite.url);
  assert.ok(heldStaleForwardScreenshot, "test must delay a real app-server screenshot for the previous page");
  const newTitleBeforeForward = rpcResponses.filter(response => response.method === "browser/screenshot" && response.page?.title === newSite.title).length;
  await activeBrowser(page).getByLabel("前进", { exact: true }).click();
  await waitForCondition(page, () => rpcResponses.some(response => response.method === "browser/action" && response.action === "forward" && response.page?.url === newSite.url));
  const forwardAddressBeforeOldFrameRelease = await address.inputValue();
  const forwardActionAuthoritativeBeforeOldFrame = forwardAddressBeforeOldFrameRelease === newSite.url;
  await page.evaluate(id => window.__workspaceQaRpcReleaseResponse(id), heldStaleForwardScreenshot.id);
  await waitForScreenshotTitle(page, rpcResponses, newSite.title, newTitleBeforeForward + 1);
  await page.waitForTimeout(250);
  const forwardAddressAfterOldFrame = await address.inputValue();
  const forwardActionAuthoritativeAfterOldFrame = forwardAddressAfterOldFrame === newSite.url;

  const reloadUrl = new URL("/?workspace-qa-reload=1", newSite.url).href;
  await address.fill(reloadUrl);
  await activeBrowser(page).getByLabel("打开", { exact: true }).click();
  const reloadTitleBaseline = rpcResponses.filter(response => response.method === "browser/screenshot" && response.page?.title === newSite.title).length;
  await waitForScreenshotTitle(page, rpcResponses, newSite.title, reloadTitleBaseline + 1);
  await waitForInputValue(page, reloadUrl);
  const reloadPriorDraft = "http://draft-before-reload.invalid/";
  await address.fill(reloadPriorDraft);
  await address.press("Tab");
  const reloadResponseCountBefore = rpcResponses.filter(response => response.method === "browser/action" && response.action === "reload" && response.page?.url === reloadUrl).length;
  await activeBrowser(page).getByLabel("刷新", { exact: true }).click();
  await waitForCondition(page, () => rpcResponses.filter(response => response.method === "browser/action" && response.action === "reload" && response.page?.url === reloadUrl).length > reloadResponseCountBefore);
  await waitForInputValue(page, reloadUrl);
  const reloadClearedPriorDraft = (await address.inputValue()) === reloadUrl;

  const reloadDraftDuringAction = "http://draft-during-reload.invalid/";
  await address.fill("http://draft-before-second-reload.invalid/");
  await address.press("Tab");
  const reloadScreenshotBaseline = screenshotCount(rpcResponses, reloadUrl);
  await page.evaluate(() => window.__workspaceQaRpcHoldNext("browser/action", { action: "reload" }));
  await activeBrowser(page).getByLabel("刷新", { exact: true }).click();
  await waitForHeldAction(page, "reload");
  await address.fill(reloadDraftDuringAction);
  await address.press("Tab");
  await waitForCondition(page, () => screenshotCount(rpcResponses, reloadUrl) > reloadScreenshotBaseline);
  await page.evaluate(() => {
    const held = window.__workspaceQaRpcHeld.find(item => item.message.method === "browser/action" && item.message.params?.action === "reload");
    if (!held) throw new Error("missing held reload action");
    window.__workspaceQaRpcRelease(held.message.id);
  });
  await waitForCondition(page, () => rpcResponses.filter(response => response.method === "browser/action" && response.action === "reload" && response.page?.url === reloadUrl).length > reloadResponseCountBefore + 1);
  await waitForScreenshotTitle(page, rpcResponses, newSite.title, reloadTitleBaseline + 2);
  await page.waitForTimeout(250);
  const reloadActionDraftRetained = (await address.inputValue()) === reloadDraftDuringAction;

  const report = {
    viewport: { width: viewportWidth, height: 844 },
    oldPageUrl: oldSite.url,
    newPageUrl: newSite.url,
    blurDraftPreserved,
    blurObservedValue: blurValue,
    pendingDraftPreserved,
    pendingObservedValue: pendingValue,
    heldNavigation,
    rejectedPendingDraftPreserved: rejectedPendingValue === invalidUrl,
    rejectedObservedPendingValue: rejectedPendingValue,
    rejectedDraftRetained: rejectedValue === invalidUrl,
    rejectedObservedValue: rejectedValue,
    rejectionResponse: rejectionResponse ?? null,
    retryConfirmed: true,
    backDraftBeforeAction,
    backDraftDuringAction,
    draftPreservedDuringBackPoll,
    heldBack,
    backActionDraftRetained,
    heldStaleForwardScreenshot,
    forwardAddressBeforeOldFrameRelease,
    forwardAddressAfterOldFrame,
    forwardActionAuthoritativeBeforeOldFrame,
    forwardActionAuthoritativeAfterOldFrame,
    reloadUrl,
    reloadPriorDraft,
    reloadClearedPriorDraft,
    reloadDraftDuringAction,
    reloadActionDraftRetained,
    rpcRequests,
    rpcResponses,
    diagnostics,
  };
  await context.writeArtifactJson("workspace-qa-browser-address-interleavings.json", report);
  assert.deepEqual(diagnostics, []);
  assert.equal(blurDraftPreserved, true, "旧页面 screenshot poll 在 blur 后不得覆盖尚未提交的新 URL 草稿");
  assert.equal(pendingDraftPreserved, true, "旧页面 screenshot poll 在 Go RPC pending 时不得覆盖新 URL 草稿");
  assert.equal(rejectedPendingValue, invalidUrl, "navigate RPC pending 时必须保留失败候选 URL");
  assert.equal(rejectedValue, invalidUrl, "服务端拒绝后必须保留原 URL 以便用户修正或重试");
  assert.ok(rejectionResponse, "拒绝必须来自真实 Gateway/app-server browser/action 响应");
  assert.equal(draftPreservedDuringBackPoll, true, "Back pending时旧页截图不得覆盖用户新输入");
  assert.equal(backActionDraftRetained, true, "Back pending期间产生的新草稿不得被 action 响应覆盖");
  assert.equal(forwardActionAuthoritativeBeforeOldFrame, true, "Forward成功后地址栏应立即切换到服务端确认的页面");
  assert.equal(forwardActionAuthoritativeAfterOldFrame, true, "Forward后的旧页面截图不得覆盖服务端确认地址");
  assert.equal(reloadClearedPriorDraft, true, "Reload用户意图应清除动作前的旧地址草稿");
  assert.equal(reloadActionDraftRetained, true, "Reload pending期间的新草稿必须继续保留");
  return {
    realGatewayAppServerAndChromium: true,
    modelIndependentScenarioProvider: true,
    oldScreenshotPollAfterBlur: true,
    oldScreenshotPollDuringNavigate: true,
    appServerRejectedInvalidScheme: true,
    correctedUrlRetryReachedFixture: true,
  };
});

async function installRpcHold(page) {
  await page.addInitScript(() => {
    const originalSend = WebSocket.prototype.send;
    const state = { rule: null, held: [], responseRule: null, heldResponses: [], methods: new Map() };
    window.__workspaceQaRpcHeld = state.held;
    window.__workspaceQaRpcHeldResponses = state.heldResponses;
    window.__workspaceQaRpcHoldNext = (method, params) => { state.rule = { method, params }; };
    window.__workspaceQaRpcHoldNextResponse = (method, pageUrl) => { state.responseRule = { method, pageUrl }; };
    window.__workspaceQaRpcRelease = id => {
      const entry = state.held.find(item => item.message.id === id && !item.released);
      if (!entry) throw new Error(`no held RPC ${id}`);
      entry.released = true;
      return originalSend.call(entry.socket, entry.payload);
    };
    window.__workspaceQaRpcReleaseResponse = id => {
      const entry = state.heldResponses.find(item => item.id === id && !item.released);
      if (!entry) throw new Error(`no held RPC response ${id}`);
      entry.released = true;
      return entry.handler.call(entry.socket, entry.event);
    };
    let messageDescriptor;
    for (let prototype = WebSocket.prototype; prototype && !messageDescriptor; prototype = Object.getPrototypeOf(prototype)) {
      messageDescriptor = Object.getOwnPropertyDescriptor(prototype, "onmessage");
    }
    if (messageDescriptor?.get && messageDescriptor?.set) {
      Object.defineProperty(WebSocket.prototype, "onmessage", {
        configurable: true,
        enumerable: messageDescriptor.enumerable,
        get() { return messageDescriptor.get.call(this); },
        set(handler) {
          if (typeof handler !== "function") return messageDescriptor.set.call(this, handler);
          const socket = this;
          const wrapped = function(event) {
            let message;
            try { message = JSON.parse(String(event.data)); } catch {}
            const method = message?.id === undefined ? null : state.methods.get(message.id);
            const rule = state.responseRule;
            if (rule && method === rule.method && (!rule.pageUrl || message?.result?.page?.url === rule.pageUrl)) {
              state.responseRule = null;
              state.heldResponses.push({
                id: message.id,
                method,
                pageUrl: message.result?.page?.url ?? null,
                socket,
                handler: wrapped,
                event,
                released: false,
              });
              return;
            }
            return handler.call(socket, event);
          };
          return messageDescriptor.set.call(this, wrapped);
        },
      });
    }
    WebSocket.prototype.send = function(payload) {
      let message;
      try { message = JSON.parse(String(payload)); } catch {}
      if (message?.id !== undefined && typeof message.method === "string") state.methods.set(message.id, message.method);
      const rule = state.rule;
      if (rule && message?.method === rule.method
          && Object.entries(rule.params).every(([key, value]) => message.params?.[key] === value)) {
        state.rule = null;
        state.held.push({ message, payload, socket: this, released: false });
        return;
      }
      return originalSend.call(this, payload);
    };
  });
}

function activeBrowser(page) { return page.locator('[data-testid="browser-panel"]:visible'); }
function screenshotCount(responses, url) { return responses.filter(response => response.method === "browser/screenshot" && response.page?.url === url).length; }

async function openUrl(page, url) {
  const browser = activeBrowser(page);
  await browser.getByTestId("browser-url-input").fill(url);
  await browser.getByLabel("打开", { exact: true }).click();
  await browser.locator('img[src^="data:image/"]').waitFor({ state: "visible", timeout: 60_000 });
}

async function waitForScreenshotTitle(page, responses, title, minimum = 1) {
  await waitForCondition(page, () => responses.filter(response => response.method === "browser/screenshot" && response.page?.title === title && response.imageBytes).length >= minimum);
}

async function waitForInputValue(page, expected) {
  await page.waitForFunction(value => [...document.querySelectorAll('[data-testid="browser-url-input"]')].some(input => input.offsetWidth > 0 && input.value === value), expected, { timeout: 30_000 });
}

async function waitForHeldRpc(page, method, url) {
  await page.waitForFunction(({ method, url }) => window.__workspaceQaRpcHeld.some(item => item.message.method === method && item.message.params?.url === url), { method, url }, { timeout: 30_000 });
}

async function waitForHeldAction(page, action) {
  await page.waitForFunction(action => window.__workspaceQaRpcHeld.some(item => item.message.method === "browser/action" && item.message.params?.action === action), action, { timeout: 30_000 });
}

async function waitForHeldResponse(page, method, pageUrl) {
  await page.waitForFunction(({ method, pageUrl }) => window.__workspaceQaRpcHeldResponses.some(item => item.method === method && item.pageUrl === pageUrl), { method, pageUrl }, { timeout: 30_000 });
}

async function waitForEnabled(page, locator) {
  await waitForCondition(page, async () => !(await locator.isDisabled()));
}

async function waitForCondition(page, condition) {
  const deadline = Date.now() + 60_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error("等待 browser RPC/frame 交错超时");
    await page.waitForTimeout(100);
  }
}

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
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

async function selectPanel(page, id) {
  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId(`workspace-tab-${id}`).click();
  await activeBrowser(page).waitFor({ state: "visible", timeout: 30_000 });
}
