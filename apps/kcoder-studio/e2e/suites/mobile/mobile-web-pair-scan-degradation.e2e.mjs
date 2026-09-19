import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-pair-scan-degradation",
  tier: "model-independent",
  modelPolicy: "real Gateway web shell; camera hardware intentionally unavailable",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const gateway = await startGateway(context, {
    auth: true,
    label: "mobile-pair-scan-web-gateway",
    workspace,
    env: { KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-pair-scan-web-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const externalQrRequests = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  page.on("requestfailed", request => diagnostics.push(`requestfailed: ${request.failure()?.errorText} ${request.url()}`));
  page.on("request", request => {
    if (/jsqr|jsdelivr|unpkg|worker/i.test(request.url())) externalQrRequests.push(request.url());
  });

  await authenticateWebShell(page, gateway);
  await page.getByTestId("welcome-scan-qr").click();
  await page.getByText("扫描配对码", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("浏览器暂不支持扫码", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.getByTestId("pairing-camera").count(), 0,
    "无相机授权的 Web 环境不能伪装成已启用扫码预览");
  assert.equal(await page.getByTestId("request-camera-permission").count(), 0,
    "Web 降级页不能诱导用户请求不会工作的原生相机权限");
  const mediaCapabilities = await page.evaluate(() => ({
    secureContext: globalThis.isSecureContext,
    hasMediaDevices: Boolean(navigator.mediaDevices),
    hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
  }));
  await page.getByTestId("pairing-web-paste-link").click();
  await page.locator('[data-testid="welcome-paste-pairing-link"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('[data-testid="welcome-paste-pairing-link"]:visible').click();
  await page.locator('[data-testid="pair-link-input"]:visible').fill("kcoder-studio://connect?gateway=https%3A%2F%2Fexample.invalid&token=example");
  assert.match(await page.locator('[data-testid="pair-link-input"]:visible').inputValue(), /^kcoder-studio:\/\/connect/);
  await context.writeArtifactJson("mobile-web-pair-scan-degradation.json", {
    mediaCapabilities,
    explicitWebFallbackRendered: true,
    cameraPreviewNotFaked: true,
    pasteLinkFieldOperational: true,
    externalQrRequests,
    diagnostics,
  });
  assert.deepEqual(externalQrRequests, [], "Web 降级页不能加载 jsQR/CDN worker");
  assert.deepEqual(diagnostics, [], "Web 扫码降级页不能因离线 CDN worker 或相机缺失产生全局错误");
  return { explicitWebFallback: true, noFakeCamera: true, noExternalQrWorker: true, pasteLinkFieldOperational: true };
});

async function authenticateWebShell(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-scan-qr"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
}
