import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-terminal-pty-tabs-reload",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic real app-server",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const gateway = await startGateway(context, { auth: true, label: "mobile-terminal-gateway", workspace, env: { KCODER_STUDIO_SCENARIO: "full-turn", KCODER_STUDIO_WEB_ROOT: mobileDist } });
  const chromium = await startChromium(context, { label: "mobile-terminal-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const rpcRequests = [];
  const rpcResponses = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`); });
  page.on("websocket", socket => {
    socket.on("framesent", event => { try { const value = JSON.parse(String(event.payload)); if (value?.method) rpcRequests.push({ id: value.id, method: value.method, params: value.params ?? null }); } catch {} });
    socket.on("framereceived", event => { try { const value = JSON.parse(String(event.payload)); if (value?.id !== undefined) rpcResponses.push({ id: value.id, result: value.result ?? null, error: value.error ?? null }); } catch {} });
  });
  await connect(page, gateway);
  await createTask(page, "MOBILE_REAL_TERMINAL");

  await selectPanel(page, "terminal-1");
  await runCommand(page, "pwd", workspace);
  await runCommand(page, "printf ONE > one.txt", "");
  assert.equal(await readFile(resolve(workspace, "one.txt"), "utf8"), "ONE");

  await page.getByTestId("workspace-add-panel").click();
  await page.getByText("启动一个独立 PTY 会话", { exact: true }).click();
  await activeTerminal(page).waitFor({ state: "visible", timeout: 30_000 });
  await assertEventuallyEnabled(activeTerminal(page).getByLabel("Enter", { exact: true }));
  await terminalText(page, /KCoder Terminal/);
  await runCommand(page, "printf TWO > two.txt", "");
  assert.equal(await readFile(resolve(workspace, "two.txt"), "utf8"), "TWO");

  await page.getByTestId("workspace-tab-switcher").click();
  const secondTab = page.getByRole("tab", { name: /终端 2/ });
  await secondTab.waitFor({ state: "visible", timeout: 10_000 });
  const secondPanelId = (await secondTab.getAttribute("data-testid"))?.replace("workspace-tab-", "");
  assert.ok(secondPanelId, "新增终端标签必须暴露稳定的 panel id");
  await page.getByTestId("workspace-tab-terminal-1").click();
  await terminalText(page, /printf ONE > one\.txt/);
  assert.doesNotMatch(await terminalContent(page), /printf TWO > two\.txt/, "两个终端的回滚内容必须隔离");
  const terminalStartsBeforeReload = rpcRequests.filter(request => request.method === "terminal/start");
  assert.equal(terminalStartsBeforeReload.length, 2, "刷新前两个标签应各自只创建一个 PTY");

  await page.reload({ waitUntil: "domcontentloaded" });
  await activeTerminal(page).waitFor({ state: "visible", timeout: 30_000 });
  try {
    await terminalText(page, /printf ONE > one\.txt/);
  } catch (error) {
    await context.writeArtifactJson("terminal-reload-persistence-failure.json", {
      activeTranscript: await terminalContent(page).catch(() => ""),
      rpcRequests,
      rpcResponses,
    });
    throw error;
  }
  assert.equal(rpcRequests.filter(request => request.method === "terminal/start").length, terminalStartsBeforeReload.length,
    "刷新必须附着已有 PTY，不能为保留的终端标签新建会话");
  await runCommand(page, "printf BACK >> one.txt", "");
  assert.equal(await readFile(resolve(workspace, "one.txt"), "utf8"), "ONEBACK");

  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId(`workspace-tab-${secondPanelId}`).click();
  await terminalText(page, /printf TWO > two\.txt/);
  await page.getByTestId("workspace-tab-switcher").click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByLabel("关闭终端 2", { exact: true }).click();
  await page.getByTestId(`workspace-tab-${secondPanelId}`).waitFor({ state: "hidden", timeout: 30_000 });

  assert.deepEqual(diagnostics, []);
  await context.writeArtifactJson("mobile-real-terminal-pty.json", { workspace, cwd: true, input: true, isolatedTabs: true, reloadRestore: true, close: true, rpcRequests, rpcResponses, diagnostics });
  return { realAppServer: true, cwd: true, terminalInput: true, isolatedTabs: true, reloadRestore: true, closeCleanup: true };
});

async function terminalContent(page) {
  return activeTerminal(page).locator(".xterm-accessibility-tree").innerText();
}

async function terminalText(page, expected) {
  await activeTerminal(page).locator(".xterm-accessibility-tree").filter({ hasText: expected }).waitFor({ state: "visible", timeout: 30_000 });
}

async function runCommand(page, command, expected) {
  await activeTerminal(page).getByLabel("Enter", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await assertEventuallyEnabled(activeTerminal(page).getByLabel("Enter", { exact: true }));
  await activeTerminal(page).locator(".xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await terminalText(page, new RegExp(expected || command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

async function assertEventuallyEnabled(locator) {
  await locator.page().waitForFunction(element => !element?.hasAttribute("disabled") && element?.getAttribute("aria-disabled") !== "true", await locator.elementHandle(), { timeout: 30_000 });
}

function activeTerminal(page) {
  return page.locator('[data-testid="terminal-panel"]:visible');
}

async function selectPanel(page, id) {
  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId(`workspace-tab-${id}`).click();
  await page.getByTestId("terminal-emulator").waitFor({ state: "visible", timeout: 30_000 });
}

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
}
