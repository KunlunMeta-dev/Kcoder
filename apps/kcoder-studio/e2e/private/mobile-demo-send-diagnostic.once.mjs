import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const previewRoot = resolve(repoRoot, "target/test/mobile-demo-send-20261010/gateway-web-export");
const bundleName = "entry-510597221f9a836174a3bdcbb651b81f.js";
const bundlePath = resolve(previewRoot, "_expo/static/js/web", bundleName);
const bundleUrlPath = `/mobile/_expo/static/js/web/${bundleName}`;
const route = "/mobile/h/demo-host/task/local/demo-1?cwd=%2Fdata%2Fprojects%2Fkcoder&demo=1";
const demoReply = "这是 Web 演示模式的模拟回复";
const mobileMountToken = "/__kcoder_mobile_mount_v1__";
const origins = [
  { id: "loopback", origin: "http://127.0.0.1:4187", secure: true, webLocks: true },
  { id: "tailscale-http", origin: "http://100.64.0.58:4187", secure: false, webLocks: false },
];

await runE2E(
  import.meta.url,
  {
    testId: "mobile-demo-send-diagnostic-once",
    tier: "manual-live",
    modelPolicy: "browser-only/model-independent DEMO diagnostic against the externally root-task-owned preview; not independent Gateway or realModel acceptance",
    previewOwner: "external root task; PID 3213020; this diagnostic does not start or stop the preview",
    expectedMobileBundle: bundleName,
    retainSuccessLogs: true,
  },
  async (context) => {
    const sourceBundle = (await readFile(bundlePath)).toString("utf8");
    const sourceBundleHash = createHash("sha256").update(sourceBundle).digest("hex");
    const mountedBundleHash = createHash("sha256")
      .update(sourceBundle.replaceAll(mobileMountToken, "/mobile"))
      .digest("hex");
    const chromium = await startChromium(context, {
      label: "mobile-demo-send-diagnostic-chromium",
      executablePath: "/usr/bin/chromium",
    });
    assert.equal(chromium.executablePath, "/usr/bin/chromium");
    assert.equal(chromium.noSandbox, true);

    const result = {
      boundary: "browser-only/model-independent DEMO diagnostic; external root-task-owned preview; not independent Gateway/realModel acceptance",
      previewPid: 3213020,
      previewRoot,
      expectedBundle: bundleName,
      origins: [],
    };

    for (const target of origins) {
      const row = {
        id: target.id,
        origin: target.origin,
        route,
        secureContext: null,
        webLocksAvailable: null,
        bundleResponse: null,
        apiRpcRequests: [],
        websocketCreated: [],
        pageErrorCount: 0,
        storageKeyCalls: [],
        sends: [],
      };
      result.origins.push(row);

      const browserContext = await chromium.browser.newContext({
        viewport: { width: 390, height: 844 },
        locale: "zh-CN",
        colorScheme: "dark",
        isMobile: true,
        hasTouch: true,
      });
      let contextClosed = false;
      context.addCleanup(`close ${target.id} browser context`, async () => {
        if (!contextClosed) {
          contextClosed = true;
          await browserContext.close();
        }
      });
      await browserContext.addInitScript(() => {
        const calls = [];
        Object.defineProperty(window, "__kcoderDemoSendStorageKeyCalls", { value: calls });
        for (const method of ["getItem", "setItem", "removeItem"]) {
          const original = Storage.prototype[method];
          Storage.prototype[method] = function (key, ...values) {
            const name = String(key);
            if (/workspace|gateway-profiles/i.test(name)) calls.push({ method, key: name });
            return Reflect.apply(original, this, [key, ...values]);
          };
        }
      });

      const page = await browserContext.newPage();
      page.on("pageerror", () => { row.pageErrorCount += 1; });
      const cdp = await browserContext.newCDPSession(page);
      let cdpDetached = false;
      context.addCleanup(`detach ${target.id} browser network observer`, async () => {
        if (!cdpDetached) {
          cdpDetached = true;
          await cdp.detach();
        }
      });
      await cdp.send("Network.enable");
      cdp.on("Network.requestWillBeSent", (event) => {
        const url = new URL(event.request.url);
        if (/\/(?:api|rpc)(?:\/|$)/i.test(url.pathname)) {
          row.apiRpcRequests.push({ method: event.request.method, path: url.pathname, resourceType: event.type ?? null });
        }
      });
      cdp.on("Network.webSocketCreated", ({ url }) => {
        row.websocketCreated.push({ path: new URL(url).pathname });
      });

      const entryResponsePromise = page.waitForResponse(
        (response) => new URL(response.url()).pathname === bundleUrlPath,
        { timeout: 20_000 },
      );
      await page.goto(`${target.origin}${route}`, { waitUntil: "load", timeout: 30_000 });
      const entryResponse = await entryResponsePromise;
      const responseHash = createHash("sha256").update(await entryResponse.body()).digest("hex");
      row.bundleResponse = {
        path: new URL(entryResponse.url()).pathname,
        status: entryResponse.status(),
        resourceType: entryResponse.request().resourceType(),
        sourceBundleSha256: sourceBundleHash,
        networkResponseSha256: responseHash,
        sha256MatchesMountedPreviewBundle: responseHash === mountedBundleHash,
      };
      await context.writeArtifactJson(`${target.id}-loaded.json`, row);
      assert.equal(row.bundleResponse.status, 200, `${target.id} must load the expected bundle`);
      assert.equal(row.bundleResponse.resourceType, "script");
      assert.equal(row.bundleResponse.sha256MatchesMountedPreviewBundle, true, "network script bytes must match the mounted preview bundle");

      const environment = await page.evaluate(() => ({
        secureContext: window.isSecureContext,
        webLocksAvailable: typeof navigator.locks?.request === "function",
      }));
      Object.assign(row, environment);
      await context.writeArtifactJson(`${target.id}-environment.json`, row);
      assert.equal(row.secureContext, target.secure, `${target.id} secure-context classification`);
      assert.equal(row.webLocksAvailable, target.webLocks, `${target.id} Web Locks availability`);

      const input = page.getByTestId("message-input");
      await input.waitFor({ state: "visible", timeout: 20_000 });
      const assistantReplies = page.getByTestId("message-assistant").filter({ hasText: demoReply });
      const failedSubmissions = page.getByTestId("failed-submission");
      const visibleUsers = page.getByTestId("message-user");

      for (let index = 1; index <= 2; index += 1) {
        const message = `演示发送诊断 ${index}`;
        await input.fill(message);
        await page.getByTestId("send-message").click();
        const send = { index, visibleUserMessages: null, visibleDemoReplies: null, inputCleared: null, failedSubmissionCount: null };
        row.sends.push(send);
        await context.writeArtifactJson(`${target.id}-send-${index}-submitted.json`, row);
        await waitFor(async () => (await assistantReplies.count()) === index, 30_000, `${target.id} demo reply ${index}`, 100);
        send.visibleUserMessages = await visibleUsers.filter({ hasText: message }).count();
        send.visibleDemoReplies = await assistantReplies.count();
        send.inputCleared = (await input.inputValue()) === "";
        send.failedSubmissionCount = await failedSubmissions.count();
        await context.writeArtifactJson(`${target.id}-send-${index}-settled.json`, row);
        assert.equal(send.visibleUserMessages, 1, `${target.id} user message ${index} must remain visible`);
        assert.equal(send.visibleDemoReplies, index, `${target.id} must show ${index} demo replies`);
        assert.equal(send.inputCleared, true, `${target.id} composer must clear after send ${index}`);
        assert.equal(send.failedSubmissionCount, 0, `${target.id} must not retain a failed submission`);
      }

      row.storageKeyCalls = await page.evaluate(() => window.__kcoderDemoSendStorageKeyCalls.slice());
      await page.waitForTimeout(150);
      await page.screenshot({ path: context.pathInArtifacts(`${target.id}-mobile-demo-send.png`), fullPage: true });
      await context.writeArtifactJson(`${target.id}-final.json`, row);
      assert.equal(row.apiRpcRequests.length, 0, `${target.id} API/RPC request count`);
      assert.equal(row.websocketCreated.length, 0, `${target.id} WebSocket connection count`);
      assert.equal(row.pageErrorCount, 0, `${target.id} pageerror count`);
      assert.deepEqual(row.storageKeyCalls, [], `${target.id} workspace/gateway-profiles storage calls`);

      cdpDetached = true;
      await cdp.detach();
      contextClosed = true;
      await browserContext.close();
    }

    await context.writeArtifactJson("mobile-demo-send-diagnostic.json", result);
    return result;
  },
);
