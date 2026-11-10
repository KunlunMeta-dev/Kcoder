import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { runE2E } from "../../harness/run-context.mjs";

await runE2E(import.meta.url, {
  testId: "mobile-web-pair-scan-degradation",
  tier: "model-independent",
  modelPolicy: "real Gateway web shell; camera hardware intentionally unavailable",
  retainSuccessLogs: true,
}, async context => {
  const mobileWeb = await exportMobileWeb(context, {
    label: "mobile-pair-scan-degradation-export",
    outputName: "mobile-pair-scan-mobile-web",
    dependencyRoot: process.env.KCODER_E2E_MOBILE_DEPENDENCY_ROOT || undefined,
    timeoutMs: 10 * 60_000,
  });
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const gateway = await startGateway(context, {
    auth: true,
    label: "mobile-pair-scan-web-gateway",
    workspace,
    env: { KCODER_STUDIO_WEB_ROOT: mobileWeb.path },
  });
  const previousUmask = process.umask(0o077);
  let chromium;
  try {
    chromium = await startChromium(context, { label: "mobile-pair-scan-web-chromium" });
  } finally {
    process.umask(previousUmask);
  }
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const externalQrRequests = [];
  const sessionExchangeRequests = [];
  page.on("pageerror", error => diagnostics.push(`pageerror:${error.name || "Error"}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(message.type());
  });
  page.on("requestfailed", request => {
    const requestUrl = new URL(request.url());
    diagnostics.push(`requestfailed:${request.failure()?.errorText ?? "unknown"} ${requestUrl.origin}${requestUrl.pathname}`);
  });
  page.on("request", request => {
    const requestUrl = new URL(request.url());
    if (request.method() === "POST" && requestUrl.origin === gateway.baseUrl && requestUrl.pathname === "/api/mobile/session") {
      sessionExchangeRequests.push({ method: "POST", path: "/api/mobile/session" });
    }
    if (/jsqr|jsdelivr|unpkg|worker/i.test(request.url())) {
      externalQrRequests.push(`${requestUrl.origin}${requestUrl.pathname}`);
    }
  });

  await authenticateWebShell(page, gateway);
  assert.equal(await page.getByTestId("welcome-scan-qr").count(), 0,
    "Web welcome must not offer an unavailable scanner action");
  await page.goto(`${gateway.baseUrl}/pair-scan`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("pairing-web-paste-link").waitFor({ state: "visible", timeout: 30_000 });
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
  await page.locator('[data-testid="pair-link-input"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForURL(url => !url.searchParams.has("connectMode"), { timeout: 10_000 });
  assert.equal(new URL(page.url()).searchParams.has("connectMode"), false,
    "The one-shot paste UI parameter must be consumed");

  const pairingLink = new URL("kcoder-studio://connect");
  pairingLink.searchParams.set("gateway", gateway.baseUrl);
  pairingLink.searchParams.set("token", gateway.authToken);
  const pairResponsePromise = page.waitForResponse(response => {
    const responseUrl = new URL(response.url());
    return response.request().method() === "POST" && responseUrl.origin === gateway.baseUrl &&
      responseUrl.pathname === "/api/mobile/session";
  }, { timeout: 30_000 });
  await page.locator('[data-testid="pair-link-input"]:visible').fill(pairingLink.toString());
  await page.getByTestId("pair-link-connect").click();
  const pairResponse = await pairResponsePromise;
  const sessionStatus = pairResponse.status();
  let sessionPayload;
  if (sessionStatus === 200) {
    sessionPayload = await pairResponse.json();
    for (const key of ["accessToken", "refreshToken", "rpcToken"]) {
      const credential = sessionPayload?.[key];
      if (typeof credential === "string" && credential.length >= 8) context.registerSecret(credential);
    }

    const accessToken = sessionPayload?.accessToken;
    if (typeof accessToken === "string" && accessToken.length >= 8) {
      let revokeAttempted = false;
      context.addCleanup("revoke Mobile Web pairing session", async () => {
        await page.close().catch(() => undefined);
        if (revokeAttempted) return;
        revokeAttempted = true;
        const response = await fetch(`${gateway.baseUrl}/api/mobile/session`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(5_000),
        });
        assert.equal(response.status, 204, "temporary paired Mobile session must be revoked before Gateway shutdown");
      });
    }
  }
  assert.equal(sessionStatus, 200, "pasting a valid run-owned pairing link must exchange a real Mobile session");
  assert.equal(typeof sessionPayload?.accessToken, "string");
  assert.equal(typeof sessionPayload?.expiresAt, "number");
  assert.equal(sessionExchangeRequests.length, 1, "one user connection action must issue one Mobile session exchange");
  await page.waitForURL(url => /^\/h\/[^/]+\/?$/.test(url.pathname), { timeout: 30_000 });
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  const finalUrl = new URL(page.url());
  const addressBarClean = !finalUrl.searchParams.has("token") && !finalUrl.href.includes(gateway.authToken);
  assert.equal(addressBarClean, true, "the connected profile URL must not retain pairing credentials");

  await context.writeArtifactJson("mobile-web-pair-scan-degradation.json", {
    mediaCapabilities,
    explicitWebFallbackRendered: true,
    unavailableScannerActionHidden: true,
    fallbackOpenedPasteDirectly: true,
    cameraPreviewNotFaked: true,
    sessionExchange: {
      method: "POST",
      path: "/api/mobile/session",
      status: sessionStatus,
      requestCount: sessionExchangeRequests.length,
      responseCount: 1,
    },
    connectedProfileHome: true,
    addressBarClean,
    mobileWebBuild: {
      sourceTreeSha256: mobileWeb.sourceTreeSha256,
      dependencySourceTreeSha256: mobileWeb.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: mobileWeb.dependencyOwnedTreeSha256,
      bundleSha256: mobileWeb.bundleSha256,
      bundleFileCount: mobileWeb.bundleFileCount,
    },
    externalQrRequests,
    diagnostics,
  });
  assert.deepEqual(externalQrRequests, [], "Web 降级页不能加载 jsQR/CDN worker");
  assert.deepEqual(diagnostics, [], "Web 扫码降级页不能因离线 CDN worker 或相机缺失产生全局错误");
  return { explicitWebFallback: true, unavailableScannerActionHidden: true, fallbackOpenedPasteDirectly: true, noFakeCamera: true, noExternalQrWorker: true, realSessionExchange: true, connectedProfileHome: true, addressBarClean };
});

async function authenticateWebShell(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-paste-pairing-link"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
}
