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
  testId: "mobile-web-real-thread-lifecycle",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic provider through real app-server",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const settingsFile = await context.writeStateJson("thread-lifecycle-settings.json", {
    active_provider: "thread-mobile",
    permission_mode: "yolo",
    providers: { "thread-mobile": provider(model.baseUrl) },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", { "thread-mobile": { type: "api", key: "deterministic-local" } });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Local", transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true, label: "mobile-thread-lifecycle-gateway", workspace, serversFile,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-thread-lifecycle-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const rpcMethods = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  page.on("websocket", socket => socket.on("framesent", event => {
    try { const value = JSON.parse(String(event.payload)); if (value?.method) rpcMethods.push(value.method); } catch {}
  }));

  await connect(page, gateway);
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill("THREAD_LIFECYCLE_BOOTSTRAP");
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
  const threadId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1));
  assert.match(threadId, /^[A-Za-z0-9._:-]+$/);

  const renamed = `真实任务生命周期-${Date.now()}`;
  await page.getByLabel("更多").click();
  const taskMenu = page.getByRole("dialog", { name: "任务操作" });
  await taskMenu.getByLabel("任务标题").fill(renamed);
  await taskMenu.getByText("重命名", { exact: true }).click();
  await taskMenu.getByText("标题已更新", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await taskMenu.getByLabel("关闭").click();
  await page.getByText(renamed, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText(renamed, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

  await page.getByLabel("更多").click();
  const archiveMenu = page.getByRole("dialog", { name: "任务操作" });
  page.once("dialog", dialog => dialog.accept());
  await archiveMenu.getByText("归档任务", { exact: true }).click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.getByTestId(`thread-${threadId}`).count(), 0, "归档任务不能留在主页最近列表");

  await page.getByTestId("sessions").click();
  await page.getByTestId("sessions-archived").click();
  const archivedRow = page.getByTestId(`session-${threadId}`);
  await archivedRow.waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await archivedRow.innerText(), new RegExp(escapeRegex(renamed)));
  await page.getByTestId("session-search").fill(renamed);
  await archivedRow.waitFor({ state: "visible", timeout: 30_000 });
  await archivedRow.click();
  await page.getByTestId("unarchive-task").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("unarchive-task").click();
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
  await send(page, "THREAD_LIFECYCLE_AFTER_RESTORE");
  assert.ok(model.requests.some(request => JSON.stringify(request).includes("THREAD_LIFECYCLE_AFTER_RESTORE")));

  await page.getByLabel("更多").click();
  const deleteMenu = page.getByRole("dialog", { name: "任务操作" });
  page.once("dialog", dialog => dialog.accept());
  await deleteMenu.getByText("删除任务", { exact: true }).click();
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  const visibleHomeButtons = await page.getByTestId("new-workspace").evaluateAll(nodes => nodes.filter(node => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }).length);
  await page.screenshot({ path: context.pathInArtifacts("duplicate-home-after-delete.png"), fullPage: true });
  await context.writeArtifactJson("mobile-real-thread-lifecycle-navigation.json", {
    threadId, renamed, urlAfterDelete: page.url(), visibleHomeButtons,
    bodyAfterDelete: (await page.locator("body").innerText()).slice(0, 8000),
    rpcMethods, diagnostics,
  });
  assert.equal(visibleHomeButtons, 1, "从历史恢复的任务永久删除后只能挂载一个可见主页");
  await page.locator('[data-testid="sessions"]:visible').click();
  await page.locator('[data-testid="session-search"]:visible').fill(renamed);
  await page.waitForTimeout(500);
  assert.equal(await page.locator(`[data-testid="session-${threadId}"]:visible`).count(), 0, "永久删除后最近历史不能再出现任务");
  await page.locator('[data-testid="sessions-archived"]:visible').click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(`[data-testid="session-${threadId}"]:visible`).count(), 0, "永久删除后归档历史不能再出现任务");
  assert.ok(rpcMethods.includes("thread/delete"), "永久删除必须到达真实 app-server");
  assert.deepEqual(diagnostics, []);

  await context.writeArtifactJson("mobile-real-thread-lifecycle.json", {
    threadId, renamed,
    renameSurvivedReload: true,
    archiveHiddenFromRecent: true,
    archivedSearchFound: true,
    restoredAndContinued: true,
    deletedFromActiveAndArchivedHistory: true,
    rpcMethods,
    diagnostics,
  });
  return {
    realRename: true, renameSurvivedReload: true, realArchive: true,
    archivedHistorySearch: true, realRestore: true, continuedAfterRestore: true,
    realPermanentDelete: true,
  };
});

function provider(endpoint) {
  return {
    api_format: "openai_chat_completions", endpoint, default_model: "thread-lifecycle-e2e-model",
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

async function send(page, prompt) {
  await page.getByTestId("message-input").fill(prompt);
  await page.getByTestId("send-message").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
