import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const execFile = promisify(execFileCallback);
const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-git-sync-branches",
  tier: "full-integration",
  modelPolicy: "model-independent real app-server device/execute and local bare Git remote",
  retainSuccessLogs: true,
}, async context => {
  const root = context.pathInState("git-fixture");
  const workspace = resolve(root, "workspace");
  const remote = resolve(root, "origin.git");
  const updater = resolve(root, "updater");
  await mkdir(workspace, { recursive: true });
  await git(workspace, "init", "-b", "main");
  await git(workspace, "config", "user.email", "mobile-sync@kcoder.local");
  await git(workspace, "config", "user.name", "Mobile Sync E2E");
  await writeFile(resolve(workspace, "README.md"), "baseline\n");
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-m", "baseline");
  await git(root, "init", "--bare", remote);
  await git(workspace, "remote", "add", "origin", remote);
  await git(workspace, "push", "-u", "origin", "main");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");

  const gateway = await startGateway(context, {
    auth: true,
    label: "mobile-git-sync-branches-gateway",
    workspace,
    env: { KCODER_STUDIO_SCENARIO: "full-turn", KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-git-sync-branches-chromium" });
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
  await createTask(page, "MOBILE_REAL_GIT_SYNC_BRANCHES");
  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId("workspace-tab-changes").click();
  await page.getByTestId("changes-panel").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByLabel("当前分支 main，打开分支菜单").waitFor({ state: "visible", timeout: 30_000 });

  await page.getByLabel("当前分支 main，打开分支菜单").click();
  await page.getByTestId("git-new-branch-name").fill("mobile/e2e-sync");
  await page.getByLabel("新建并切换分支").click();
  await waitFor(async () => (await gitOutput(workspace, "branch", "--show-current")) === "mobile/e2e-sync",
    30_000, "UI 新建并切换分支");
  await page.getByLabel("当前分支 mobile/e2e-sync，打开分支菜单").waitFor({ state: "visible", timeout: 30_000 });

  await writeFile(resolve(workspace, "from-feature.txt"), "created on feature\n");
  await git(workspace, "add", "from-feature.txt");
  await git(workspace, "commit", "-m", "feature from mobile branch");
  await page.getByLabel("刷新 Git 变更").click();
  await page.getByLabel("推送当前分支").click();
  await waitFor(async () => (await gitOutput(remote, "show-ref", "--verify", "refs/heads/mobile/e2e-sync")).length > 0,
    30_000, "UI 首次 push 并建立 upstream");

  await page.getByLabel("当前分支 mobile/e2e-sync，打开分支菜单").click();
  await clickAndAccept(page, page.getByTestId(`git-branch-option-${encodeURIComponent("main")}`));
  await waitFor(async () => (await gitOutput(workspace, "branch", "--show-current")) === "main", 30_000, "UI 切回 main");
  await page.getByLabel("选择要合并的分支").click();
  await clickAndAccept(page, page.getByTestId(`git-branch-option-${encodeURIComponent("mobile/e2e-sync")}`));
  await waitFor(async () => {
    try { await access(resolve(workspace, "from-feature.txt")); return true; } catch { return false; }
  }, 30_000, "UI merge 后工作树出现 feature 文件");
  await page.getByLabel("推送当前分支").click();
  await waitFor(async () => (await gitOutput(remote, "rev-parse", "refs/heads/main")) === (await gitOutput(workspace, "rev-parse", "main")),
    30_000, "UI push 合并后的 main");

  await git(root, "clone", remote, updater);
  await git(updater, "config", "user.email", "remote-updater@kcoder.local");
  await git(updater, "config", "user.name", "Remote Updater");
  await writeFile(resolve(updater, "from-remote.txt"), "remote only\n");
  await git(updater, "add", "from-remote.txt");
  await git(updater, "commit", "-m", "remote update");
  await git(updater, "push", "origin", "main");
  await page.getByLabel("刷新 Git 变更").click();
  await page.getByLabel("拉取远端提交").click();
  await waitFor(async () => {
    try { await access(resolve(workspace, "from-remote.txt")); return true; } catch { return false; }
  }, 30_000, "UI fast-forward pull");

  await context.writeArtifactJson("mobile-real-git-sync-branches.json", {
    currentBranch: await gitOutput(workspace, "branch", "--show-current"),
    localHead: await gitOutput(workspace, "rev-parse", "HEAD"),
    remoteHead: await gitOutput(remote, "rev-parse", "refs/heads/main"),
    deviceCommands,
    diagnostics,
  });
  for (const command of ["git_checkout_new", "git_push", "git_checkout", "git_merge", "git_pull_ff"]) {
    assert.ok(deviceCommands.includes(command), `缺少真实 device/execute ${command}`);
  }
  assert.equal(await gitOutput(workspace, "rev-parse", "HEAD"), await gitOutput(remote, "rev-parse", "refs/heads/main"));
  assert.deepEqual(diagnostics, []);
  return { createBranch: true, firstPushUpstream: true, switchBranch: true, mergeBranch: true, push: true, pullFastForward: true };
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
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
}

async function clickAndAccept(page, locator) {
  let accepted = false;
  page.once("dialog", dialog => {
    accepted = true;
    void dialog.accept();
  });
  await locator.click();
  assert.equal(accepted, true, "Git 分支破坏性操作必须显示浏览器确认框");
}

async function git(cwd, ...args) {
  return execFile("git", args, { cwd });
}

async function gitOutput(cwd, ...args) {
  return (await git(cwd, ...args)).stdout.trim();
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`等待 ${label} 超时 (${timeoutMs}ms)`);
}
