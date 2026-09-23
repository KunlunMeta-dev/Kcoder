import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-gateway-disconnect-reconnect",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic provider with real gateway restart",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    delayedRequestNumber: 1,
    streamDelayMs: 30_000,
  });
  const settingsFile = await context.writeStateJson("reconnect-settings.json", {
    active_provider: "reconnect-mobile",
    permission_mode: "yolo",
    providers: {
      "reconnect-mobile": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "reconnect-e2e-model",
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
  await context.writeStateJson("config/credentials.json", {
    "reconnect-mobile": { type: "api", key: "deterministic-local-fixture" },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Local",
    transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"),
    workspace,
    settingsFile,
  }]);
  const gatewayOptions = {
    auth: true,
    workspace,
    serversFile,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
  };
  const gateway = await startGateway(context, { ...gatewayOptions, label: "mobile-reconnect-gateway-before" });
  const chromium = await startChromium(context, { label: "mobile-reconnect-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const pageErrors = [];
  const consoleMessages = [];
  const rpcMethods = [];
  const rpcEvents = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) consoleMessages.push(`${message.type()}: ${message.text()}`);
  });
  page.on("websocket", socket => {
    socket.on("framesent", event => {
      try {
        const value = JSON.parse(String(event.payload));
        if (value?.method) rpcMethods.push(value.method);
      } catch {}
    });
    socket.on("framereceived", event => {
      try {
        const value = JSON.parse(String(event.payload));
        if (value?.method) rpcEvents.push({ method: value.method, params: value.params ?? null });
      } catch {}
    });
  });

  await connect(page, gateway);
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill("RECONNECT_INTERRUPTED_FIRST_TURN");
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("stop-turn").waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(() => rpcEvents.some(event => event.method === "turn/started"), 30_000, "turn/started stream event");
  await page.getByTestId("stop-turn").click();
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
  assert.ok(rpcMethods.includes("turn/interrupt"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("已停止", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("message-user").filter({ hasText: "RECONNECT_INTERRUPTED_FIRST_TURN" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("message-input").fill("RECONNECT_COMPLETED_BEFORE_RESTART");
  await page.getByTestId("send-message").click();
  await page.getByTestId("message-user").filter({ hasText: "RECONNECT_COMPLETED_BEFORE_RESTART" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
  const taskUrl = page.url();
  assert.match(taskUrl, /\/task\/local\//);
  const taskThreadId = new URL(taskUrl).pathname.split("/").at(-1);
  assert.ok(taskThreadId);

  await selectPanel(page, "terminal-1");
  await runTerminalCommand(page, "pwd", workspace);
  await runTerminalCommand(page, "printf BEFORE_RESTART > terminal-before.txt && printf B_OK", "B_OK");
  assert.equal(await readFile(resolve(workspace, "terminal-before.txt"), "utf8"), "BEFORE_RESTART");
  const terminalStartsBeforeRestart = rpcMethods.filter(method => method === "terminal/start").length;
  assert.equal(terminalStartsBeforeRestart, 1);

  await context.stopOwned("mobile-reconnect-gateway-before");
  await selectPanel(page, "agent");
  const disconnectBanner = page.getByText("连接已断开，正在自动重连；恢复后会同步服务器上的最新状态。", { exact: true });
  await disconnectBanner.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await page.getByTestId("message-input").isEditable(), false, "断线期间输入框必须禁止编辑");
  assert.equal(await page.getByTestId("send-message").getAttribute("aria-disabled"), "true", "断线期间发送按钮必须禁用");
  assert.match(await page.locator("body").innerText(), /离线/);
  assert.equal(page.url(), taskUrl, "断线不应把用户踢出当前任务");

  const restarted = await startGateway(context, {
    ...gatewayOptions,
    authToken: gateway.authToken,
    port: gateway.port,
    label: "mobile-reconnect-gateway-after",
  });
  assert.equal(restarted.baseUrl, gateway.baseUrl);
  const profileId = decodeURIComponent(taskUrl.match(/\/h\/([^/]+)\/task\//)?.[1] ?? "");
  assert.ok(profileId);
  await page.getByText("Gateway 会话已失效，请前往设置重新连接", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByLabel("打开任务列表").click();
  await page.getByTestId("mobile-drawer").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("mobile-drawer").getByLabel("设置").click();
  const reauthorize = page.getByTestId(`reauthorize-profile-${profileId}`);
  try {
    await reauthorize.waitFor({ state: "visible", timeout: 15_000 });
  } catch (error) {
    await context.writeArtifactJson("gateway-reauthorization-missing.json", {
      profileId,
      taskUrl,
      restartedGatewayUrl: restarted.baseUrl,
      body: (await page.locator("body").innerText()).slice(0, 12_000),
      rpcMethods,
      consoleMessages,
      pageErrors,
    });
    throw error;
  }
  await reauthorize.click();
  await page.getByTestId("gateway-endpoint").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await page.getByTestId("gateway-endpoint").inputValue(), gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  const visibleRestoredThreads = page.locator(`[data-testid="thread-${taskThreadId}"]:visible`);
  const restoredThread = visibleRestoredThreads.first();
  await restoredThread.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await visibleRestoredThreads.count(), 1, "重新授权后的当前主页只能显示一个可见线程入口");
  await restoredThread.click();
  await disconnectBanner.waitFor({ state: "hidden", timeout: 30_000 });
  await selectPanel(page, "agent");
  const activeMessageInput = page.locator('[data-testid="message-input"]:visible');
  await activeMessageInput.first().waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await activeMessageInput.count(), 1, "恢复后的当前任务只能存在一个可见输入框");
  assert.equal(await activeMessageInput.isEditable(), true, "重新授权后输入框必须重新可用");
  assert.match(await page.locator("body").innerText(), /已连接/);
  await page.locator('[data-testid="message-user"]:visible').filter({ hasText: "RECONNECT_INTERRUPTED_FIRST_TURN" }).waitFor({ state: "visible", timeout: 15_000 });
  await page.locator('[data-testid="message-user"]:visible').filter({ hasText: "RECONNECT_COMPLETED_BEFORE_RESTART" }).waitFor({ state: "visible", timeout: 15_000 });

  await activeMessageInput.fill("RECONNECT_AFTER_REAUTHORIZATION");
  await page.locator('[data-testid="send-message"]:visible').click();
  await page.locator('[data-testid="message-user"]:visible').filter({ hasText: "RECONNECT_AFTER_REAUTHORIZATION" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('[data-testid="send-message"]:visible').waitFor({ state: "visible", timeout: 60_000 });
  const providerPrompts = model.requests.map(request => JSON.stringify(request));
  assert.ok(providerPrompts.some(value => value.includes("RECONNECT_INTERRUPTED_FIRST_TURN")));
  assert.ok(providerPrompts.some(value => value.includes("RECONNECT_COMPLETED_BEFORE_RESTART")));
  assert.ok(providerPrompts.some(value => value.includes("RECONNECT_AFTER_REAUTHORIZATION")));
  assert.ok(rpcMethods.filter(method => method === "thread/resume").length >= 1, "恢复连接必须 resume 原会话");
  assert.ok(rpcMethods.filter(method => ["thread/read", "thread/read/indexed"].includes(method)).length >= 1, "恢复连接必须重新同步历史");

  await selectPanel(page, "terminal-1");
  const terminalRestart = page.locator('[data-testid="terminal-restart"]:visible');
  await page.waitForTimeout(1_000);
  const restartVisible = await terminalRestart.isVisible();
  const enter = activeTerminal(page).getByLabel("Enter", { exact: true });
  const terminalRecoveryState = {
    restartVisible,
    enterAriaDisabled: await enter.getAttribute("aria-disabled").catch(() => null),
    alerts: await activeTerminal(page).getByRole("alert").allInnerTexts().catch(() => []),
    transcript: await activeTerminal(page).locator(".xterm-accessibility-tree").innerText().catch(() => ""),
    terminalStarts: rpcMethods.filter(method => method === "terminal/start").length,
  };
  await context.writeArtifactJson("mobile-real-terminal-after-gateway-restart.json", terminalRecoveryState);
  assert.equal(restartVisible, true, "旧 PTY attach 失败后必须显示明确的重新启动入口");
  await terminalRestart.click();
  await runTerminalCommand(page, "pwd", workspace);
  await runTerminalCommand(page, "printf AFTER_RESTART > terminal-after.txt && printf A_OK", "A_OK");
  assert.equal(await readFile(resolve(workspace, "terminal-after.txt"), "utf8"), "AFTER_RESTART");
  assert.equal(rpcMethods.filter(method => method === "terminal/start").length,
    terminalStartsBeforeRestart + 1,
    "旧 PTY 失效后用户恢复必须只新建一个终端会话");
  const terminalStartsBeforeReload = rpcMethods.filter(method => method === "terminal/start").length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await activeTerminal(page).waitFor({ state: "visible", timeout: 30_000 });
  await activeTerminal(page).locator(".xterm-accessibility-tree").filter({ hasText: "A_OK" }).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(rpcMethods.filter(method => method === "terminal/start").length, terminalStartsBeforeReload,
    "刷新必须 attach 恢复后的 PTY，不能再创建第三个会话");
  const terminalClosesBeforeUserClose = rpcMethods.filter(method => method === "terminal/close").length;
  await page.locator('[data-testid="workspace-tab-switcher"]:visible').click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByLabel("关闭终端 1", { exact: true }).click();
  await page.getByTestId("workspace-tab-terminal-1").waitFor({ state: "hidden", timeout: 30_000 });
  assert.equal(rpcMethods.filter(method => method === "terminal/close").length, terminalClosesBeforeUserClose + 1,
    "用户关闭恢复后的终端标签必须清理当前 PTY");
  const openAgentTab = page.locator('[data-testid="workspace-tab-agent"]:visible');
  if (await openAgentTab.count()) await openAgentTab.click();
  else await selectPanel(page, "agent");
  const unexpectedConsoleMessages = consoleMessages.filter(message =>
    !/^error: WebSocket connection to '.+' failed: (Error in connection establishment: net::ERR_CONNECTION_REFUSED|Connection closed before receiving a handshake response)$/.test(message));
  assert.deepEqual(unexpectedConsoleMessages, [], "除主动停 Gateway 产生的 WebSocket 失败外不能有 console 错误或 warning");
  assert.deepEqual(pageErrors, []);
  await context.writeArtifactJson("mobile-real-gateway-reconnect.json", {
    taskUrl,
    sameGatewayUrl: restarted.baseUrl === gateway.baseUrl,
    explicitReauthorization: true,
    offlineComposerLocked: true,
    historyRecovered: true,
    secondTurnCompleted: true,
    interruptedTurnRecoveredAfterReload: true,
    preRestartCompletedTurnRecovered: true,
    terminalBeforeRestart: true,
    terminalRestartRecovery: true,
    terminalRecoveryState,
    terminalReloadAttachedWithoutStart: true,
    terminalUserCloseCleanedUp: true,
    unexpectedConsoleMessages,
    rpcMethods,
    rpcEvents,
    consoleMessages,
    pageErrors,
  });
  return {
    realGatewayRestart: true,
    offlineStateVisible: true,
    offlineSendPrevented: true,
    explicitReauthorization: true,
    threadResumed: true,
    historyRecovered: true,
    interruptedTurnReloadRecovered: true,
    completedTurnBeforeRestartRecovered: true,
    terminalLifecycleRecovered: true,
    postReconnectTurnCompleted: true,
  };
});

async function waitFor(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`等待 ${label} 超时`);
}

async function selectPanel(page, id) {
  await page.locator('[data-testid="workspace-tab-switcher"]:visible').click();
  await page.locator(`[data-testid="workspace-tab-${id}"]:visible`).click();
}

function activeTerminal(page) {
  return page.locator('[data-testid="terminal-panel"]:visible');
}

async function runTerminalCommand(page, command, expected) {
  const terminal = activeTerminal(page);
  const enter = terminal.getByLabel("Enter", { exact: true });
  await enter.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(element => !element?.hasAttribute("disabled") && element?.getAttribute("aria-disabled") !== "true", await enter.elementHandle(), { timeout: 30_000 });
  await terminal.locator(".xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await terminal.locator(".xterm-accessibility-tree").filter({ hasText: expected }).waitFor({ state: "visible", timeout: 30_000 });
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
