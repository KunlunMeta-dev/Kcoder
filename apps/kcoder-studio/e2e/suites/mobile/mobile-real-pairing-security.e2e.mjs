import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-pairing-security",
  tier: "full-integration",
  modelPolicy: "model-independent real Gateway session exchange",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const gateway = await startGateway(context, {
    auth: true,
    label: "mobile-pairing-security-gateway",
    workspace,
    env: { KCODER_STUDIO_SCENARIO: "full-turn", KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-pairing-security-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const networkDiagnostics = [];
  let sessionExchangeRequests = 0;
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/mobile/session") sessionExchangeRequests += 1;
  });
  page.on("response", response => {
    if (response.status() >= 400) networkDiagnostics.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", request => networkDiagnostics.push(`${request.failure()?.errorText} ${request.url()}`));

  await authenticateWebShell(page, gateway);
  const rejectedToken = `rejected-pairing-${Date.now()}`;
  const rejectedUrl = `${gateway.baseUrl}/connect?gateway=${encodeURIComponent(gateway.baseUrl)}&token=${encodeURIComponent(rejectedToken)}`;
  await page.goto(rejectedUrl, { waitUntil: "domcontentloaded" });
  await page.getByText("连接失败", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const urlAfterRejectedPairing = page.url();
  const rejectedTokenInAddress = urlAfterRejectedPairing.includes(rejectedToken);
  const rejectedTokenInDiagnostics = diagnostics.some(message => message.includes(rejectedToken));
  const exchangesBeforeRetry = sessionExchangeRequests;
  await page.getByTestId("pairing-retry").click();
  await waitFor(() => sessionExchangeRequests > exchangesBeforeRetry, 30_000, "错误配对重试请求");
  await page.getByText("连接失败", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

  const validPairingUrl = `${gateway.baseUrl}/connect?gateway=${encodeURIComponent(gateway.baseUrl)}&token=${encodeURIComponent(gateway.authToken)}`;
  await page.goto(validPairingUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  const firstProfileId = profileIdFromHome(page.url());
  const firstProfiles = await storedProfiles(page);
  const validTokenInFirstFinalUrl = page.url().includes(gateway.authToken) || new URL(page.url()).searchParams.has("token");
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.includes("连接失败")
    || document.body.innerText.includes("配对链接缺少 Gateway 地址或 access token。"), undefined, { timeout: 30_000 });
  const secretInBackHistoryEntry = page.url().includes(rejectedToken) || page.url().includes(gateway.authToken) || new URL(page.url()).searchParams.has("token");
  await page.goForward({ waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });

  await page.goto(validPairingUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  const secondProfileId = profileIdFromHome(page.url());
  const secondProfiles = await storedProfiles(page);
  const validTokenInSecondFinalUrl = page.url().includes(gateway.authToken) || new URL(page.url()).searchParams.has("token");

  const unsupportedToken = `unsupported-pairing-${Date.now()}`;
  await page.goto(`${gateway.baseUrl}/connect?gateway=${encodeURIComponent("file:///etc/passwd")}&token=${encodeURIComponent(unsupportedToken)}`, { waitUntil: "domcontentloaded" });
  await page.getByText("连接失败", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const unsupportedSchemeError = await page.getByRole("alert").innerText();
  const unsupportedTokenInAddress = page.url().includes(unsupportedToken);
  const anySecretInDiagnostics = [...diagnostics, ...networkDiagnostics].some(message =>
    [rejectedToken, unsupportedToken, gateway.authToken].some(secret => message.includes(secret)));

  await page.goto(`${gateway.baseUrl}/connect?gateway=${encodeURIComponent(gateway.baseUrl)}`, { waitUntil: "domcontentloaded" });
  await page.getByText("配对链接缺少 Gateway 地址或 access token。", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByLabel("返回").click();
  await page.getByTestId("welcome-paste-pairing-link").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-paste-pairing-link").click();
  await page.getByTestId("pair-link-input").fill("ftp://connect?gateway=http%3A%2F%2Fexample.invalid&token=not-used");
  await page.getByText("连接", { exact: true }).last().click();
  await page.getByText("不是有效的 KCoder 配对链接", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const unexpectedDiagnostics = diagnostics.filter(message =>
    message !== "error: Failed to load resource: the server responded with a status of 401 (Unauthorized)");

  await context.writeArtifactJson("rejected-pairing-redaction.json", {
    route: new URL(urlAfterRejectedPairing).pathname,
    rejectedTokenInAddress,
    rejectedTokenInDiagnostics,
    retryIssuedAnotherExchange: sessionExchangeRequests > exchangesBeforeRetry,
    validTokenInFirstFinalUrl,
    validTokenInSecondFinalUrl,
    secretInBackHistoryEntry,
    firstProfileId,
    secondProfileId,
    firstProfileCount: firstProfiles.length,
    secondProfileCount: secondProfiles.length,
    unsupportedSchemeError,
    unsupportedTokenInAddress,
    networkDiagnostics,
    diagnostics,
    unexpectedDiagnostics,
    anySecretInDiagnostics,
    diagnosticsContainSecret: rejectedTokenInDiagnostics,
  });
  assert.equal(rejectedTokenInAddress, false, "错误 token 被拒绝后必须立即从浏览器地址栏移除");
  assert.equal(rejectedTokenInDiagnostics, false, "错误 token 不能出现在浏览器 console/pageerror");
  assert.equal(validTokenInFirstFinalUrl, false, "成功配对后的最终地址不能保留 token");
  assert.equal(validTokenInSecondFinalUrl, false, "重复配对后的最终地址不能保留 token");
  assert.equal(secretInBackHistoryEntry, false, "浏览器返回历史中的 connect 地址也不能恢复 token");
  assert.equal(firstProfileId, secondProfileId, "同一 Gateway 重复配对必须复用 profile id");
  assert.equal(firstProfiles.length, 1, "首次配对应仅创建一个 profile");
  assert.equal(secondProfiles.length, 1, "重复配对不能创建重复 profile");
  assert.match(unsupportedSchemeError, /只支持 http:\/\/ 或 https:\/\//);
  assert.equal(unsupportedTokenInAddress, false, "不支持的 Gateway scheme 报错后也必须清除 token");
  assert.equal(anySecretInDiagnostics, false, "console、pageerror 和网络错误诊断都不能包含配对 secret");
  assert.deepEqual(unexpectedDiagnostics, [], "除预期的错误 token 401 外不应出现 pageerror/console error，尤其不能出现 React #418");

  return { rejectedPairingRecovered: true, pairingTokenRedacted: true, duplicateProfileReused: true, malformedPairingRecovered: true };
});

async function authenticateWebShell(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
}

function profileIdFromHome(url) {
  const id = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean)[1] ?? "");
  assert.ok(id, "配对成功应进入包含 profile id 的首页");
  return id;
}

async function storedProfiles(page) {
  return page.evaluate(() => {
    const value = JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") || "{}");
    return Array.isArray(value.profiles) ? value.profiles : [];
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`等待 ${label} 超时 (${timeoutMs}ms)`);
}
