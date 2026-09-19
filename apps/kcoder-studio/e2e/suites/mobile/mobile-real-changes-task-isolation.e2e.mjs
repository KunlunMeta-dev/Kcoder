import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const execFile = promisify(execFileCallback);
const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-changes-task-state-isolation",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic real app-server",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, "README.md"), "task isolation\n");
  await execFile("git", ["init", "-b", "main"], { cwd: workspace });
  await execFile("git", ["config", "user.email", "mobile-e2e@kcoder.local"], { cwd: workspace });
  await execFile("git", ["config", "user.name", "Mobile E2E"], { cwd: workspace });
  await execFile("git", ["add", "."], { cwd: workspace });
  await execFile("git", ["commit", "-m", "baseline"], { cwd: workspace });
  const gateway = await startGateway(context, { auth: true, label: "mobile-task-isolation-gateway", workspace, env: { KCODER_STUDIO_SCENARIO: "full-turn", KCODER_STUDIO_WEB_ROOT: mobileDist } });
  const chromium = await startChromium(context, { label: "mobile-task-isolation-chromium" });
  const browserContext = chromium.browser.contexts()[0];
  const diagnostics = [];
  const observe = page => {
    page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
    page.on("console", message => { if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`); });
  };
  const first = await browserContext.newPage();
  await first.setViewportSize({ width: 390, height: 844 }); observe(first);
  await connect(first, gateway);
  const homeUrl = first.url();
  const firstUrl = await createTask(first, "MOBILE_CHANGES_TASK_ONE");
  const firstId = threadId(firstUrl);
  await first.getByTestId("workspace-tab-switcher").click();
  await first.getByTestId("workspace-tab-changes").click();
  await first.getByTestId("changes-panel").waitFor({ state: "visible" });
  await first.getByTestId("workspace-tab-switcher").getByText("变更", { exact: true }).waitFor({ state: "visible" });

  const second = await browserContext.newPage();
  await second.setViewportSize({ width: 390, height: 844 }); observe(second);
  await second.goto(homeUrl, { waitUntil: "domcontentloaded" });
  await second.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  const secondUrl = await createTask(second, "MOBILE_CHANGES_TASK_TWO");
  const secondId = threadId(secondUrl);
  assert.notEqual(firstId, secondId);
  await second.getByTestId("workspace-tab-switcher").getByText("智能体", { exact: true }).waitFor({ state: "visible" });

  await first.close();
  await second.getByLabel("打开任务列表").click();
  await second.getByTestId(`drawer-thread-${firstId}`).click();
  try {
    await second.getByTestId("workspace-tab-switcher").getByText("变更", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    await context.writeArtifactJson("task-switch-failure.json", {
      firstId, secondId, url: second.url(),
      taskOneMessageVisible: await second.getByTestId("message-user").filter({ hasText: "MOBILE_CHANGES_TASK_ONE" }).count(),
      taskTwoMessageVisible: await second.getByTestId("message-user").filter({ hasText: "MOBILE_CHANGES_TASK_TWO" }).count(),
      body: (await second.locator("body").innerText()).slice(-8000),
      localStorage: await second.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes("mobile-workspace-state")))),
    });
    throw error;
  }
  await second.getByTestId("changes-panel").waitFor({ state: "visible" });
  await second.getByLabel("打开任务列表").click();
  await second.getByTestId(`drawer-thread-${secondId}`).click();
  await second.getByTestId("workspace-tab-switcher").getByText("智能体", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  assert.deepEqual(diagnostics, []);
  await context.writeArtifactJson("mobile-real-changes-task-isolation.json", { firstId, secondId, firstActivePanel: "changes", secondActivePanel: "agent", diagnostics });
  return { realAppServer: true, twoTasks: true, activePanelIsolatedAcrossDrawerSwitch: true };
});

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }), page.locator('button[type="submit"]').click()]);
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
  return page.url();
}

function threadId(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1));
}
