import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
const execFile = promisify(execFileCallback);
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-turn-change-revert",
  tier: "full-integration",
  modelPolicy: "deterministic provider through real engine, app-server artifact review/revert",
  retainSuccessLogs: true,
}, async context => {
  const repository = context.pathInState("repository");
  const workspace = resolve(repository, "nested-workspace");
  const configDir = context.pathInState("config");
  const changedFile = resolve(workspace, "turn-artifact.txt");
  await mkdir(workspace, { recursive: true });
  await execFile("git", ["init", "-b", "main"], { cwd: repository });
  await execFile("git", ["config", "user.email", "turn-revert@kcoder.local"], { cwd: repository });
  await execFile("git", ["config", "user.name", "Turn Revert E2E"], { cwd: repository });
  await writeFile(resolve(workspace, "README.md"), "baseline\n");
  await execFile("git", ["add", "."], { cwd: repository });
  await execFile("git", ["commit", "-m", "baseline"], { cwd: repository });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const model = await startApprovalModelFixture(context, {
    approvalCommand: "printf 'turn artifact change\\n' > turn-artifact.txt",
  });
  const settingsFile = await context.writeStateJson("turn-revert-settings.json", {
    active_provider: "turn-revert-mobile",
    permission_mode: "yolo",
    providers: {
      "turn-revert-mobile": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "turn-revert-e2e-model",
        context_window_tokens: 128000,
        output_headroom_tokens: 8192,
        max_output_tokens: 8192,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", { "turn-revert-mobile": { type: "api", key: "deterministic-local" } });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Local", transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true,
    label: "mobile-turn-change-revert-gateway",
    workspace,
    serversFile,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-turn-change-revert-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const deviceCommands = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  page.on("websocket", socket => socket.on("framesent", event => {
    try {
      const value = JSON.parse(String(event.payload));
      if (value?.method === "device/execute") deviceCommands.push(value.params?.command_key);
    } catch {}
  }));

  await connect(page, gateway);
  await createTask(page, "CREATE_REAL_TURN_ARTIFACT");
  await waitFor(() => exists(changedFile), 30_000, "模型工具创建回合文件");
  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId("workspace-tab-changes").click();
  await page.getByTestId("changes-mode-turn").click();
  await page.getByLabel("撤销本回合变更").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText(/个已更改文件/).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("+turn artifact change", { exact: true }).waitFor({ state: "visible" });
  const confirmation = page.waitForEvent("dialog");
  const clickRevert = page.getByLabel("撤销本回合变更").click();
  const dialog = await confirmation;
  assert.match(dialog.message(), /撤销此回合/);
  await dialog.accept();
  await clickRevert;
  await waitFor(async () => !(await exists(changedFile)), 30_000, "服务端撤销回合文件").catch(async error => {
    await context.writeArtifactJson("failure-state.json", { body: await page.locator("body").innerText() });
    await page.screenshot({ path: context.pathInArtifacts("failure.png") });
    throw error;
  });
  await page.getByText("已撤销", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  assert.ok(deviceCommands.includes("turn_file_changes_review"), "回合 Changes 必须真实读取服务端 diff");
  assert.ok(deviceCommands.includes("turn_file_changes_revert"), "撤销必须真实调用服务端 artifact revert");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="workspace-tab-switcher"]:visible').click();
  await page.locator('[data-testid="workspace-tab-changes"]:visible').click();
  await page.locator('[data-testid="changes-mode-turn"]:visible').click();
  await page.getByText("已撤销", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.locator('[aria-label="撤销本回合变更"]:visible').count(), 0,
    "刷新后已撤销 artifact 不能再次提供撤销按钮");
  await context.writeArtifactJson("mobile-real-turn-change-revert.json", { repository, workspace, changedFile, deviceCommands, diagnostics });
  assert.deepEqual(diagnostics, []);
  return { realTurnArtifact: true, reviewedDiff: true, revertedOnDisk: true, revertedStateSurvivesReload: true };
});

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
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, prompt) {
  await page.locator('[data-testid="new-workspace"]:visible').click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("权限确认后的命令已执行。", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`等待 ${label} 超时 (${timeoutMs}ms)`);
}
