import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(import.meta.url, {
  testId: "kcoder-real-app-server-web-slash-commands",
  tier: "full-integration",
  modelPolicy: "model-independent composer actions through one real KCoder app-server",
  retainSuccessLogs: true,
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, "minimal", {
    instanceId: "kcoder-runtime-web-slash",
  });
  const configDir = context.pathInState("kcoder-config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("kcoder-config/settings.json", {});
  await context.writeStateJson("kcoder-config/credentials.json", {
    "kcoder-slash-e2e": { type: "api", key: "deterministic-local" },
  });
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const settingsFile = await context.writeStateJson("kcoder-settings.json", {
    active_provider: "kcoder-slash-e2e",
    providers: {
      "kcoder-slash-e2e": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "kcoder-slash-e2e-model",
        context_window_tokens: 128_000,
        output_headroom_tokens: 8_192,
        max_output_tokens: 8_192,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "KCoder Slash E2E", runtime: "kcoder", transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    workspace, serversFile, auth: true,
    env: { KCODER_CONFIG_DIR: configDir },
  });
  const chromium = await startChromium(context, { label: "kcoder-slash-web-chromium" });
  const page = await chromium.newPage({ viewport: { width: 1280, height: 800 } });
  const diagnostics = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem("wework.localModelSettings.v1", JSON.stringify({
      configs: [{ id: "legacy-browser-secret", apiKey: "must-be-removed" }],
    }));
    localStorage.setItem("wework.local-proxy-settings", JSON.stringify({
      proxyUrl: "http://legacy-user:legacy-secret@127.0.0.1:7890",
    }));
  });

  await login(page, gateway.baseUrl, gateway.authToken);
  const clearedLegacyExecutionSettings = await page.evaluate(() => ({
    models: localStorage.getItem("wework.localModelSettings.v1"),
    proxy: localStorage.getItem("wework.local-proxy-settings"),
  }));
  assert.deepEqual(clearedLegacyExecutionSettings, { models: null, proxy: null });
  const project = page.getByTestId("project-item").filter({ hasText: "KCoder Slash E2E" }).first();
  await project.waitFor({ state: "visible", timeout: 60_000 });
  await project.hover();
  await project.getByTestId("project-new-conversation-button").click();
  await sendPrompt(page, "SLASH_WEB_BOOTSTRAP");
  await page.getByTestId("message-assistant").last().waitFor({ state: "visible", timeout: 60_000 });
  await page.evaluate(() => {
    const runtimeWindow = window;
    const internals = runtimeWindow.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") throw new Error("KCoder gateway invoke shim is unavailable");
    const originalInvoke = internals.invoke;
    runtimeWindow.__slashRpcResults = [];
    internals.invoke = async function(command, args) {
      try {
        const result = await originalInvoke.call(this, command, args);
        if (command === "local_executor_request") {
          runtimeWindow.__slashRpcResults.push({ request: args, result });
        }
        return result;
      } catch (error) {
        if (command === "local_executor_request") {
          runtimeWindow.__slashRpcResults.push({
            request: args,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    };
  });

  const composer = page.getByTestId("chat-message-input");
  const platformShortcutsPreserved = await composer.evaluate(element => {
    const dispatch = (key, modifiers) => element.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      code: key.startsWith("Arrow") ? key : `Key${key.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    }));
    return {
      metaArrowLeft: dispatch("ArrowLeft", { metaKey: true }),
      metaArrowRight: dispatch("ArrowRight", { metaKey: true }),
      controlA: dispatch("a", { ctrlKey: true }),
      controlE: dispatch("e", { ctrlKey: true }),
    };
  });
  assert.deepEqual(platformShortcutsPreserved, {
    metaArrowLeft: true,
    metaArrowRight: true,
    controlA: true,
    controlE: true,
  }, "composer must not cancel native platform text-navigation shortcuts");
  await composer.click();
  await page.keyboard.insertText("/");
  const slashMenu = page.getByTestId("slash-command-menu");
  await slashMenu.waitFor({ state: "visible", timeout: 10_000 });
  const menuCommands = await slashMenu.getByRole("option").allTextContents();
  for (const command of ["/plan", "/goal", "/goal-pro", "/moa", "/moa-plan", "/compact", "/model"]) {
    assert.ok(menuCommands.some(text => text.includes(command)), `slash menu missing ${command}`);
  }
  assert.ok(!menuCommands.some(text => text.includes('/ultgoal')));
  assert.ok(!menuCommands.some(text => text.includes('/orchestrate')), 'Started sessions must not offer a session-mode change');
  const runtimeSendCountBeforeSafetyChecks = await countRuntimeRequests(page, "runtime.tasks.send");
  await page.getByTestId("send-message-button").click();
  await page.getByTestId("chat-input-error").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await page.getByTestId("plan-mode-pill").count(), 0, "bare slash must not execute the first command");
  await composer.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("/goa");
  await page.keyboard.press("Tab");
  assert.equal((await composer.textContent())?.trim(), "/goal", "Tab must complete without executing");
  assert.equal(await page.getByTestId("goal-draft-pill").count(), 0, "Tab must not execute goal");
  await composer.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("/unknown");
  await page.getByTestId("send-message-button").click();
  await page.getByTestId("chat-input-error").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await page.getByTestId("message-user").filter({ hasText: "/unknown" }).count(), 0);
  assert.equal(
    await countRuntimeRequests(page, "runtime.tasks.send"),
    runtimeSendCountBeforeSafetyChecks,
    "send button must not forward bare or unknown slash commands to the runtime",
  );
  await composer.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");

  await submitSlashWithButton(page, composer, "/plan");
  await page.getByTestId("plan-mode-pill").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await page.getByTestId("message-user").filter({ hasText: "/plan" }).count(), 0);
  await page.getByTestId("cancel-plan-mode-button").click({ force: true });
  await page.getByTestId("plan-mode-pill").waitFor({ state: "detached", timeout: 10_000 });

  await submitSlashWithButton(page, composer, "/goal");
  await page.getByTestId("goal-draft-pill").waitFor({ state: "visible", timeout: 10_000 });
  assert.match(await composer.getAttribute("placeholder") || "", /方向|目标/);
  await page.getByTestId("cancel-goal-draft-button").click({ force: true });

  await submitSlashWithButton(page, composer, "/model");
  await page.getByTestId("model-selector-menu").waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page.getByTestId("model-selector-menu").waitFor({ state: "detached", timeout: 10_000 });

  await composer.click();
  await page.keyboard.insertText("/goa");
  await page.getByTestId("slash-command-menu").waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page.getByTestId("slash-command-menu").waitFor({ state: "detached", timeout: 10_000 });
  await page.waitForTimeout(100);
  assert.equal(await page.getByTestId("slash-command-menu").count(), 0, "Escape keyup must not reopen slash autocomplete");
  await composer.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");

  await composer.click();
  await page.keyboard.insertText("/comp");
  await page.getByTestId("slash-command-option-compact").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("slash-command-option-compact").click();
  await page.waitForFunction(() => window.__slashRpcResults?.some(entry => entry?.request?.method === "runtime.tasks.compact"), undefined, { timeout: 30_000 });
  const compactRpc = await page.evaluate(() => window.__slashRpcResults.find(entry =>
    entry?.request?.method === "runtime.tasks.compact"
  ));
  assert.equal(compactRpc.error, undefined);
  assert.equal(compactRpc.result?.accepted, true);
  assert.ok(compactRpc.result?.taskId);
  assert.equal(await page.getByTestId("message-user").filter({ hasText: "/compact" }).count(), 0);

  await composer.click();
  await page.keyboard.insertText("/goal SLASH_INLINE_GOAL_OBJECTIVE");
  await page.getByTestId("send-message-button").click();
  await page.getByTestId("goal-draft-pill").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await composer.textContent())?.trim(), "SLASH_INLINE_GOAL_OBJECTIVE");
  assert.equal(
    await countRuntimeRequests(page, "runtime.tasks.send"),
    runtimeSendCountBeforeSafetyChecks,
    "inline goal syntax must enter goal draft mode before any runtime send",
  );
  await page.getByTestId("send-message-button").click();
  await page.waitForFunction(() => window.__slashRpcResults?.some(entry =>
    entry?.request?.method === "runtime.tasks.goal.set"
    && entry?.request?.params?.mode === "standard"
    && entry?.request?.params?.objective === "SLASH_INLINE_GOAL_OBJECTIVE"
  ), undefined, { timeout: 30_000 });
  const inlineGoalSetRpc = await page.evaluate(() => window.__slashRpcResults.find(entry =>
    entry?.request?.method === "runtime.tasks.goal.set"
    && entry?.request?.params?.mode === "standard"
    && entry?.request?.params?.objective === "SLASH_INLINE_GOAL_OBJECTIVE"
  ));
  assert.equal(inlineGoalSetRpc?.error, undefined);
  assert.equal(inlineGoalSetRpc?.result?.accepted, true);

  await composer.click();
  await page.keyboard.insertText("/goal-p");
  const goalPro = page.getByTestId("slash-command-option-goal-pro");
  await goalPro.waitFor({ state: "visible", timeout: 10_000 });
  assert.match(await goalPro.innerText(), /\/goal-pro/);
  await goalPro.click();
  await page.getByTestId("goal-draft-pill").waitFor({ state: "visible", timeout: 10_000 });
  assert.match(await composer.getAttribute("placeholder") || "", /独立验证|independent verification/);
  await composer.click();
  await page.keyboard.insertText("SLASH_GOAL_PRO_OBJECTIVE");
  await page.getByTestId("send-message-button").click();
  await page.waitForFunction(() => window.__slashRpcResults?.some(entry =>
    entry?.request?.method === "runtime.tasks.goal.set"
    && entry?.request?.params?.mode === "strict"
    && entry?.request?.params?.objective === "SLASH_GOAL_PRO_OBJECTIVE"
  ), undefined, { timeout: 30_000 });
  const goalSetRpc = await page.evaluate(() => window.__slashRpcResults.find(entry =>
    entry?.request?.method === "runtime.tasks.goal.set"
    && entry?.request?.params?.mode === "strict"
    && entry?.request?.params?.objective === "SLASH_GOAL_PRO_OBJECTIVE"
  ));
  assert.equal(goalSetRpc.error, undefined);
  assert.equal(goalSetRpc.result?.accepted, true);
  assert.equal(goalSetRpc.result?.goal?.objective, "SLASH_GOAL_PRO_OBJECTIVE");
  assert.equal(goalSetRpc.result?.goal?.mode, "strict");

  const persistedGoal = await page.evaluate(async address => {
    return window.__TAURI_INTERNALS__.invoke("local_executor_request", {
      method: "runtime.tasks.goal.get",
      params: { address },
    });
  }, goalSetRpc.request.params.address);
  assert.equal(persistedGoal?.accepted, true);
  assert.equal(persistedGoal?.goal?.objective, "SLASH_GOAL_PRO_OBJECTIVE");
  assert.equal(persistedGoal?.goal?.mode, "strict");

  const secondContext = await chromium.browser.newContext({ viewport: { width: 1024, height: 720 } });
  const secondPage = await secondContext.newPage();
  await login(secondPage, gateway.baseUrl, gateway.authToken);
  const secondBrowserGoal = await secondPage.evaluate(async address => {
    return window.__TAURI_INTERNALS__.invoke("local_executor_request", {
      method: "runtime.tasks.goal.get",
      params: { address },
    });
  }, goalSetRpc.request.params.address);
  await secondContext.close();
  assert.equal(secondBrowserGoal?.accepted, true);
  assert.equal(secondBrowserGoal?.goal?.objective, "SLASH_GOAL_PRO_OBJECTIVE");
  assert.equal(secondBrowserGoal?.goal?.mode, "strict");

  const blockedGatewaySettingsRoutes = {};
  // API settings are now target-owned and supported; only the legacy local
  // proxy/plugin editors must redirect to General.
  await page.goto(new URL('/settings/personal/models', gateway.baseUrl).href, {waitUntil:'domcontentloaded'});
  await page.getByTestId('kcoder-provider-settings-page').waitFor({timeout:30000});
  assert.equal(await page.getByTestId('model-settings-page').count(), 0);
  for (const [name, path] of [
    ["proxy", "/settings/personal/proxy"],
    ["plugins", "/settings/plugins"],
  ]) {
    await page.goto(new URL(path, gateway.baseUrl).href, { waitUntil: "domcontentloaded" });
    await page.getByTestId("general-settings-page").waitFor({ state: "visible", timeout: 30_000 });
    blockedGatewaySettingsRoutes[name] = {
      generalVisible: true,
      modelNavVisible: await page.getByTestId("settings-nav-model-settings").isVisible().catch(() => false),
      proxyNavVisible: await page.getByTestId("settings-nav-proxy").isVisible().catch(() => false),
      pluginNavVisible: await page.getByTestId("settings-nav-plugins").isVisible().catch(() => false),
    };
    assert.deepEqual(blockedGatewaySettingsRoutes[name], {
      generalVisible: true,
      modelNavVisible: true,
      proxyNavVisible: false,
      pluginNavVisible: false,
    });
  }
  const hiddenNativeGeneralControls = [
    "general-show-main-window-on-launch-toggle",
    "general-system-drag-toggle",
    "general-external-content-import-button",
    "general-close-to-tray-toggle",
    "general-prevent-sleep-while-tasks-running-toggle",
    "general-task-completion-notifications-toggle",
    "general-tray-unread-toggle",
    "general-tray-running-toggle",
    "general-tray-usage-toggle",
  ];
  await page.getByTestId("general-language-system-button").waitFor({ state: "visible", timeout: 30_000 });
  for (const testId of hiddenNativeGeneralControls) {
    assert.equal(await page.getByTestId(testId).count(), 0, `${testId} 不应出现在 HTTP Gateway 设置中`);
  }

  await page.screenshot({ path: context.pathInArtifacts("studio-slash-commands.png"), fullPage: true });
  await context.writeArtifactJson("runtime-target-slash-commands.json", {
    supportedMenuCommands: menuCommands,
    inlineGoalSetRpc,
    compactRpc,
    goalSetRpc,
    persistedGoal,
    secondBrowserGoal,
    clearedLegacyExecutionSettings,
    blockedGatewaySettingsRoutes,
    hiddenNativeGeneralControls,
    commandActions: {
      planDraftActivated: true,
      standardGoalDraftActivated: true,
      legacyArrangementCommandHidden: true,
      modelSelectorOpened: true,
    },
    platformShortcutsPreserved,
    slashSafety: {
      bareSlashBlockedBySendButton: true,
      unknownBlockedBySendButton: true,
      runtimeSendCountBeforeSafetyChecks,
      runtimeSendCountAfterSafetyChecks: await countRuntimeRequests(page, "runtime.tasks.send"),
      tabCompletedWithoutExecuting: true,
    },
    diagnostics,
  });
  assert.deepEqual(diagnostics, []);
  return {
    supportedTuiSubsetMenu: true,
    compactWasNotSubmittedAsPrompt: true,
    compactAcceptedByAppServer: compactRpc.result?.accepted === true,
    strictGoalPersistedByAppServer: secondBrowserGoal?.goal?.mode === "strict",
    platformShortcutsPreserved: true,
  };
});

async function login(page, baseUrl, token) {
  const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(token);
  await Promise.all([
    page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 20_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 60_000 });
}

async function sendPrompt(page, prompt) {
  const composer = page.getByTestId("chat-message-input");
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.click();
  await page.keyboard.insertText(prompt);
  await page.getByTestId("send-message-button").click();
}

async function countRuntimeRequests(page, method) {
  return page.evaluate(requestMethod =>
    window.__slashRpcResults?.filter(entry => entry?.request?.method === requestMethod).length ?? 0,
  method);
}

async function selectSlashCommand(page, composer, command) {
  await composer.click();
  await page.keyboard.insertText(`/${command}`);
  const option = page.getByTestId(`slash-command-option-${command}`);
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await option.click();
}

async function submitSlashWithButton(page, composer, command) {
  await composer.click();
  await page.keyboard.insertText(command);
  await page.getByTestId("send-message-button").click();
}
