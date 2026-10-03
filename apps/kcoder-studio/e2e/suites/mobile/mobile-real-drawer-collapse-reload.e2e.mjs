import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-drawer-collapse-reload",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic provider through real app-server",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const settingsFile = await context.writeStateJson("drawer-collapse-settings.json", {
    active_provider: "drawer-mobile", permission_mode: "yolo",
    providers: { "drawer-mobile": provider(model.baseUrl) },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", { "drawer-mobile": { type: "api", key: "deterministic-local" } });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Local", transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true, label: "mobile-drawer-collapse-gateway", workspace, serversFile,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-drawer-collapse-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });

  await connect(page, gateway);
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill("DRAWER_COLLAPSE_REAL_THREAD");
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
  const threadId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1));

  await page.getByLabel("打开任务列表").click();
  const drawer = page.getByTestId("mobile-drawer");
  await drawer.waitFor({ state: "visible", timeout: 30_000 });
  const toggle = drawer.getByTestId("drawer-toggle-server-local");
  await toggle.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  await drawer.getByTestId(`drawer-thread-${threadId}`).waitFor({ state: "visible", timeout: 30_000 });
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await drawer.getByTestId(`drawer-thread-${threadId}`).count(), 0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByLabel("打开任务列表").click();
  const restoredDrawer = page.getByTestId("mobile-drawer");
  const restoredToggle = restoredDrawer.getByTestId("drawer-toggle-server-local");
  await restoredToggle.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await restoredToggle.getAttribute("aria-expanded"), "false", "折叠状态必须跨页面刷新持久化");
  assert.equal(await restoredDrawer.getByTestId(`drawer-thread-${threadId}`).count(), 0);
  await restoredToggle.click();
  assert.equal(await restoredToggle.getAttribute("aria-expanded"), "true");
  await restoredDrawer.getByTestId(`drawer-thread-${threadId}`).waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await restoredDrawer.getByTestId(`drawer-thread-${threadId}`).innerText(), /DRAWER_COLLAPSE_REAL_THREAD/);
  await restoredToggle.click();
  assert.equal(await restoredToggle.getAttribute("aria-expanded"), "false");
  await restoredDrawer.getByLabel("主页").click();
  const homeToggle = page.getByTestId("toggle-server-local");
  await homeToggle.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await homeToggle.getAttribute("aria-expanded"), "false", "主页必须同步 drawer 的工作区折叠状态");
  assert.equal(await page.getByTestId(`thread-${threadId}`).count(), 0);
  await homeToggle.click();
  assert.equal(await homeToggle.getAttribute("aria-expanded"), "true");
  await page.getByTestId(`thread-${threadId}`).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId(`thread-${threadId}`).click();
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByLabel("打开任务列表").click();
  const syncedDrawerToggle = page.getByTestId("mobile-drawer").getByTestId("drawer-toggle-server-local");
  await syncedDrawerToggle.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await syncedDrawerToggle.getAttribute("aria-expanded"), "true", "主页展开后 drawer 必须同步为展开");
  await page.getByTestId("mobile-drawer").getByTestId(`drawer-thread-${threadId}`).waitFor({ state: "visible", timeout: 30_000 });
  assert.deepEqual(diagnostics, []);

  await context.writeArtifactJson("mobile-real-drawer-collapse-reload.json", {
    threadId,
    collapsedBeforeReload: true,
    collapsedAfterReload: true,
    realThreadHiddenWhileCollapsed: true,
    realThreadReturnedAfterExpand: true,
    homeAndDrawerStateSynchronized: true,
    diagnostics,
  });
  return {
    realThread: true, realWorkspaceSection: true,
    collapseHidesThreads: true, collapseSurvivesReload: true, expandRestoresThreads: true,
    homeAndDrawerStateSynchronized: true,
  };
});

function provider(endpoint) {
  return {
    api_format: "openai_chat_completions", endpoint, default_model: "drawer-collapse-e2e-model",
    context_window_tokens: 128000, output_headroom_tokens: 8192,
    max_output_tokens: 8192, request_timeout_secs: 30, no_proxy: true, extra_body: {},
  };
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
