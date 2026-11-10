import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { relative, resolve, sep } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startFixtureSite } from "../harness/fixture-site.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../harness/run-context.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import {
  buildGatewayMobileWebManifest,
  writeGatewayMobileWebManifest as writeGatewayMobileWebManifestFile,
} from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";

process.umask(0o077);
const execFile = promisify(execFileCallback);
const BASELINE = "a2f422447760c3fdd5323719d3193d6914d02bb7";
const PREFERENCES_KEY = "kcoder-studio:mobile-app-preferences:v1";
const MOBILE_SOURCE = resolve(appRoot, "mobile");
const SHARED_SOURCE = resolve(appRoot, "shared");
const DEPENDENCIES = resolve(MOBILE_SOURCE, "node_modules");
const VIEWPORT = { width: 390, height: 844 };

await runE2E(import.meta.url, {
  testId: "mobile-browser-settings-ia-visual-diff",
  tier: "one-off-acceptance",
  retainSuccessLogs: true,
  modelPolicy: "paired Mobile Web captures through RunContext-owned Gateway, app-server, fixture and Chromium; no model request",
}, async context => {
  assert.ok(process.env.KCODER_E2E_KCODER_BIN, "visual acceptance requires a pinned app-server binary path");
  assert.ok(process.env.KCODER_E2E_KCODER_BIN_SHA256, "visual acceptance requires the pinned app-server SHA-256");
  const head = await execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(head.stdout.trim(), BASELINE, "visual acceptance must start from the declared integration commit");

  const baselineRoot = context.pathInState("baseline-source");
  const baselineArchive = context.pathInState("baseline-source.tar");
  await mkdir(baselineRoot, { recursive: false, mode: 0o700 });
  const archive = await execFile("git", ["archive", BASELINE, "apps/kcoder-studio/mobile", "apps/kcoder-studio/shared"], {
    cwd: repoRoot,
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
  });
  await writeFile(baselineArchive, archive.stdout, { flag: "wx", mode: 0o600 });
  await execFile("tar", ["-xf", baselineArchive, "-C", baselineRoot], { maxBuffer: 8 * 1024 * 1024 });

  const before = await exportMobileWeb(context, {
    mobileRoot: resolve(baselineRoot, "apps/kcoder-studio/mobile"),
    sourceRoots: [
      { name: "mobile", path: resolve(baselineRoot, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: resolve(baselineRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
    ],
    dependencyRoot: DEPENDENCIES,
    label: "browser-settings-before-export",
    outputName: "browser-settings-before-web",
    stateNamespace: "browser-settings-before-export-state",
    deployMount: true,
    timeoutMs: 10 * 60_000,
    overallTimeoutMs: 45 * 60_000,
  });
  const after = await exportMobileWeb(context, {
    mobileRoot: MOBILE_SOURCE,
    sourceRoots: [
      { name: "mobile", path: MOBILE_SOURCE, destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: SHARED_SOURCE, destination: "apps/kcoder-studio/shared" },
    ],
    dependencyRoot: DEPENDENCIES,
    label: "browser-settings-after-export",
    outputName: "browser-settings-after-web",
    stateNamespace: "browser-settings-after-export-state",
    deployMount: true,
    timeoutMs: 10 * 60_000,
    overallTimeoutMs: 45 * 60_000,
  });
  const beforeGatewayManifestSha256 = await writeGatewayManifest(before);
  const afterGatewayManifestSha256 = await writeGatewayManifest(after);

  const binary = resolve(process.env.KCODER_E2E_KCODER_BIN);
  const binarySha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256, "app-server binary differs from the declared pin");
  const fixture = await startFixtureSite(context, {
    title: "本地浏览器演示",
    marker: "浏览器测试页面",
  });
  const chromium = await startChromium(context, {
    label: "browser-settings-mobile-web-chromium",
    startTimeoutMs: 60_000,
  });

  const capture = async ({ webRoot, label, exported, gatewayManifestSha256, includeWorkspaceBrowser = false }) => {
    const workspace = context.pathInState(`browser-settings-${label}-workspace`);
    const configDir = context.pathInState(`browser-settings-${label}-config`);
    await mkdir(workspace, { recursive: false, mode: 0o700 });
    await mkdir(configDir, { recursive: false, mode: 0o700 });
    const gateway = await startGateway(context, {
      label: `browser-settings-${label}-gateway`,
      auth: true,
      workspace,
      kcoderBin: binary,
      env: {
        KCODER_CONFIG_DIR: configDir,
        XDG_CONFIG_HOME: configDir,
        KCODER_STUDIO_SCENARIO: "full-turn",
        KCODER_STUDIO_MOBILE_WEB_ROOT: webRoot,
        KCODER_CHROMIUM_BIN: process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium",
        KCODER_CHROMIUM_NO_SANDBOX: "1",
      },
    });
    const browserContext = await chromium.browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const page = await browserContext.newPage();
    const diagnostics = [];
    const rpcMethods = [];
    let stage = "mobile-mount";
    let routes = null;
    page.on("pageerror", error => diagnostics.push({
      at: new Date().toISOString(), type: "pageerror", text: error.message, route: page.url(), stage,
    }));
    page.on("console", message => {
      if (["error", "warning"].includes(message.type())) diagnostics.push({
        at: new Date().toISOString(), type: message.type(), text: message.text(),
        route: page.url(), stage, location: message.location(),
      });
    });
    page.on("websocket", socket => {
      let socketScope = null;
      try {
        const url = new URL(socket.url());
        socketScope = {
          channel: url.searchParams.get("channel"),
          server: url.searchParams.get("server"),
          workspace: url.searchParams.get("workspace"),
          hasToken: Boolean(url.searchParams.get("token")),
        };
      } catch {}
      const byId = new Map();
      socket.on("framesent", event => {
        try {
          const value = JSON.parse(String(event.payload));
          if (!value?.method?.startsWith("browser/")) return;
          const record = { id: value.id, method: value.method, params: value.params ?? null, socketScope };
          rpcMethods.push(record);
          byId.set(value.id, record);
        } catch {}
      });
    });
    await page.addInitScript(({ key }) => {
      localStorage.setItem(key, JSON.stringify({ language: "zh-CN", theme: "light" }));
    }, { key: PREFERENCES_KEY });

    try {
      await connect(page, gateway);
      stage = "settings-home";
      await page.goto(`${gateway.baseUrl}/mobile/settings`, { waitUntil: "domcontentloaded" });
      const home = page.getByTestId("settings-home");
      await home.waitFor({ state: "visible", timeout: 30_000 });
      const rows = await home.locator('[data-testid][role="button"]').evaluateAll(nodes =>
        nodes.filter(node => node.dataset.testid !== "settings-detail-back").map(node => node.dataset.testid));
      assert.equal(rows.length, label === "before" ? 15 : 14, `${label} Settings registry count`);
      assert.equal(rows.includes("settings-section-browser"), label === "before", `${label} Browser settings route presence`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
        `${label} Settings home must fit the 390px viewport`);
      await page.getByTestId("settings-group-tools_extensions").scrollIntoViewIfNeeded();
      const settingsShot = await saveScreenshot(context, page, `l4-browser-settings-${label}-390x844-zh-CN-light.png`);

      let browserEvidence = null;
      if (includeWorkspaceBrowser) {
        stage = "workspace-creation";
        await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
        routes = await createTask(page, "查看本地浏览器页面");
        assert.equal(new URL(routes.before).pathname, "/mobile/new");
        assert.ok(new URL(routes.workspace).pathname.startsWith("/mobile/h/"));
        assert.ok(new URL(routes.after).pathname.startsWith("/mobile/h/"));

        stage = "browser-panel-selection";
        await selectBrowserPanel(page);
        stage = "browser-session-start";
        await openBrowserUrl(page, fixture.url);
        const browserSocket = rpcMethods.find(item => item.socketScope?.channel === "browser")?.socketScope ?? null;
        assert.ok(browserSocket?.hasToken && browserSocket.server === "local",
          "workspace browser must use the active profile and local server");
        assert.equal(browserSocket.workspace, workspace, "workspace browser must use the task cwd");
        const browserMethods = rpcMethods.filter(item => item.socketScope?.channel === "browser").map(item => item.method);
        assert.equal(browserMethods.filter(method => method === "browser/start").length, 1,
          "workspace BrowserPanel must create exactly one browser session");
        const preflightIndex = browserMethods.indexOf("browser/preflight");
        const startIndex = browserMethods.indexOf("browser/start");
        assert.ok(preflightIndex >= 0 && startIndex > preflightIndex,
          "workspace BrowserPanel must preflight before starting its task-scoped session");
        const browserShot = await saveScreenshot(context, page, "l4-workspace-browserpanel-after-390x844-zh-CN-light.png");
        browserEvidence = {
          screenshot: browserShot.path,
          screenshotSha256: browserShot.sha256,
          route: new URL(routes.after).pathname,
          fixtureUrl: fixture.url,
          rpcMethods: browserMethods,
          browserSocket,
        };
      }

      const expectedLifecycleWarning = diagnostics.filter(event => isExpectedCatalogAbort(event, {
        workspace, routes,
      }));
      const unexpectedDiagnostics = diagnostics.filter(event => event.type === "pageerror" || !expectedLifecycleWarning.includes(event));
      return {
        sourceTreeSha256: exported.sourceTreeSha256,
        bundleSha256: exported.bundleSha256,
        dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
        gatewayManifestSha256,
        settings: { screenshot: settingsShot.path, screenshotSha256: settingsShot.sha256, rows, count: rows.length },
        workspaceBrowser: browserEvidence,
        routes,
        expectedLifecycleWarning,
        unexpectedDiagnostics,
        locale: "zh-CN",
        theme: "light",
        viewport: "390x844@1x",
      };
    } finally {
      await browserContext.close();
      await context.stopOwned(`browser-settings-${label}-gateway`);
    }
  };

  const beforeCapture = await capture({ webRoot: before.path, label: "before", exported: before, gatewayManifestSha256: beforeGatewayManifestSha256 });
  const afterCapture = await capture({ webRoot: after.path, label: "after", exported: after, gatewayManifestSha256: afterGatewayManifestSha256, includeWorkspaceBrowser: true });
  assert.deepEqual(beforeCapture.unexpectedDiagnostics, [], "baseline Mobile capture must have no unexpected diagnostics");
  assert.deepEqual(afterCapture.unexpectedDiagnostics, [], "updated Mobile capture must have no unexpected diagnostics");
  assert.equal(beforeCapture.dependencySourceTreeSha256, afterCapture.dependencySourceTreeSha256,
    "before and after Mobile Web builds must use the same dependency source tree");
  assert.notEqual(beforeCapture.sourceTreeSha256, afterCapture.sourceTreeSha256);
  await context.writeArtifactJson("visual-source-provenance.json", {
    baselineCommit: BASELINE,
    currentHead: head.stdout.trim(),
    runContext: relative(repoRoot, context.runRoot).split(sep).join("/"),
    appServerBinarySha256: binarySha256,
    gatewayFixtureUrl: fixture.url,
    mobileStaticManifestSha256: { before: beforeGatewayManifestSha256, after: afterGatewayManifestSha256 },
    before: beforeCapture,
    after: afterCapture,
    nativeValidation: false,
  });
  return { baselineCommit: BASELINE, before: beforeCapture, after: afterCapture, nativeValidation: false };
});

async function writeGatewayManifest(exported) {
  const manifest = await buildGatewayMobileWebManifest(exported.path, { expectedFiles: exported.bundleFiles });
  await writeGatewayMobileWebManifestFile(exported.path, manifest);
  const manifestPath = resolve(exported.path, "kcoder-mobile-web.json");
  return createHash("sha256").update(await readFile(manifestPath)).digest("hex");
}

async function connect(page, gateway) {
  const response = await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, "the owned Gateway must serve the real Mobile Web mount");
  assert.equal(new URL(page.url()).pathname, "/mobile/");
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, prompt) {
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  const before = page.url();
  const profileId = new URL(before).searchParams.get("profileId");
  assert.ok(profileId, "new-workspace route must carry a profile owner");
  const workspace = new URL(`/mobile/h/${profileId}`, before).href;
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
  return { before, workspace, after: page.url() };
}

async function selectBrowserPanel(page) {
  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId("workspace-tab-browser-1").click();
  await page.locator('[data-testid="browser-panel"]:visible').waitFor({ state: "visible", timeout: 30_000 });
}

async function openBrowserUrl(page, url) {
  const panel = page.locator('[data-testid="browser-panel"]:visible');
  await panel.getByTestId("browser-url-input").fill(url);
  await panel.getByLabel("打开", { exact: true }).click();
  await panel.locator('img[src^="data:image/"]').waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(expected => {
    const panel = document.querySelector('[data-testid="browser-panel"]');
    return panel?.querySelector('[data-testid="browser-url-input"]')?.value === expected &&
      Boolean(panel?.querySelector('img[src^="data:image/"]'));
  }, url, { timeout: 30_000 });
}

async function saveScreenshot(context, page, filename) {
  const path = context.pathInArtifacts(filename);
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  await chmod(path, 0o600);
  return { path: `artifacts/${filename}`, sha256: createHash("sha256").update(await readFile(path)).digest("hex") };
}

function isExpectedCatalogAbort(event, { workspace, routes }) {
  if (event.type !== "warning" || event.stage !== "workspace-creation" || !routes) return false;
  if (event.route !== routes.workspace || !(event.location?.url ?? "").includes("/mobile/_expo/static/js/web/entry-")) return false;
  const match = event.text.match(/^WebSocket connection to '([^']+)' failed: WebSocket is closed before the connection is established\.$/);
  if (!match) return false;
  try {
    const socketUrl = new URL(match[1]);
    const beforeRoute = new URL(routes.before);
    const workspaceRoute = new URL(routes.workspace);
    const afterRoute = new URL(routes.after);
    return socketUrl.protocol === "ws:" && socketUrl.hostname === "127.0.0.1" && socketUrl.pathname === "/rpc" &&
      socketUrl.searchParams.get("channel") === "runtime" && socketUrl.searchParams.get("server") === "local" &&
      socketUrl.searchParams.get("workspace") === workspace && Boolean(socketUrl.searchParams.get("token")) &&
      beforeRoute.pathname === "/mobile/new" && workspaceRoute.pathname.startsWith("/mobile/h/") &&
      afterRoute.pathname.startsWith(`${workspaceRoute.pathname}/task/`);
  } catch { return false; }
}
