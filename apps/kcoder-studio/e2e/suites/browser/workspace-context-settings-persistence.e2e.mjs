import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(
  import.meta.url,
  {
    testId: "workspace-context-settings-client-and-runtime-persistence",
    tier: "browser-real-app-server",
    modelPolicy: "no model turn; isolated real Gateway and app-server",
    retainSuccessLogs: true,
  },
  async (context) => {
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "workspace-context-settings",
    });
    const toolsConfig = { disabled: ['Spec*'], coerce: { semantic_boolean: false }, luna: { allowed: ['read'] } };
    const settingsPath = await context.writeStateJson('tool-profile-config/settings.json', { providers: {}, tools: toolsConfig });
    const gateway = await startGateway(context, {
      label: "workspace-context-settings-gateway",
      workspace,
      auth: true,
      env: { KCODER_CONFIG_DIR: context.pathInState('tool-profile-config') },
    });
    const chromium = await startChromium(context, {
      label: "workspace-context-settings-chromium",
    });
    const primaryContext = await chromium.browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const primary = await primaryContext.newPage();
    const diagnostics = [];
    observe(primary, diagnostics, "primary");

    await login(primary, gateway);
    await openContextSettings(primary, gateway);

    // Toolset is target configuration, not a client preference. Exercise the real
    // select popup, RPC save, persisted sibling fields, reload and second client.
    const toolProfile = primary.getByTestId('tool-profile-select');
    await primary.waitForFunction(() => {
      const select = document.querySelector('[data-testid="tool-profile-select"]');
      return select && !select.disabled;
    });
    assert.equal(await toolProfile.inputValue(), 'full');
    await toolProfile.click();
    await primary.getByRole('listbox').getByRole('option', { name: '核心工具集', exact: true }).click();
    await primary.getByTestId('tool-profile-save').click();
    await primary.getByTestId('tool-profile-settings').getByRole('status').waitFor();
    const persistedTools = JSON.parse(await readFile(settingsPath, 'utf8')).tools;
    assert.deepEqual(persistedTools, { ...toolsConfig, profile: 'core' });

    const terminalToggle = primary.getByTestId(
      "context-terminal-injection-toggle",
    );
    await assertSwitch(terminalToggle, true);
    await terminalToggle.click();
    await assertSwitch(terminalToggle, false);
    await primary.waitForFunction(() => {
      const preferences = JSON.parse(
        localStorage.getItem("kcoder-studio:app-preferences") || "{}",
      );
      return preferences.terminalContextInjectionEnabled === false;
    });

    await primary.getByTestId("codex-personality-select").click();
    await primary.getByTestId("codex-personality-option-friendly").click();
    await assertPersonality(primary, "亲和");

    const instructions = "E2E_CONTEXT_SHARED_INSTRUCTIONS";
    const instructionsInput = primary.getByTestId(
      "context-studio-instructions-textarea",
    );
    await instructionsInput.fill(instructions);
    await saveInstructions(primary);
    await assertInstructions(primary, instructions);

    await primary.reload({ waitUntil: "domcontentloaded" });
    await primary
      .getByTestId("context-settings-page")
      .waitFor({ state: "visible", timeout: 30_000 });
    await assertSwitch(
      primary.getByTestId("context-terminal-injection-toggle"),
      false,
    );
    await assertPersonality(primary, "亲和");
    await assertInstructions(primary, instructions);
    assert.equal(await primary.getByTestId('tool-profile-select').inputValue(), 'core');

    const secondaryContext = await chromium.browser.newContext({
      viewport: { width: 1024, height: 720 },
    });
    const secondary = await secondaryContext.newPage();
    observe(secondary, diagnostics, "secondary");
    await login(secondary, gateway);
    await openContextSettings(secondary, gateway);
    await secondary.waitForFunction(() => document.querySelector('[data-testid="tool-profile-select"]')?.value === 'core');

    await assertSwitch(
      secondary.getByTestId("context-terminal-injection-toggle"),
      true,
    );
    await assertPersonality(secondary, "亲和");
    await assertInstructions(secondary, instructions);
    assert.equal(
      await secondary.evaluate(() =>
        localStorage.getItem("kcoder-studio:app-preferences"),
      ),
      null,
      "第二个浏览器 profile 不应继承第一个客户端的界面偏好",
    );

    await instructionsInput.fill("");
    await saveInstructions(primary);
    await assertInstructions(primary, "");
    await secondary.reload({ waitUntil: "domcontentloaded" });
    await secondary
      .getByTestId("context-settings-page")
      .waitFor({ state: "visible", timeout: 30_000 });
    await assertInstructions(secondary, "");

    await primary.goto(new URL('/settings', gateway.baseUrl).href);
    await primary.getByTestId('general-language-en-button').click();
    await openContextSettings(primary, gateway);
    await primary.waitForFunction(() => document.querySelector('[data-testid="tool-profile-select"]')?.value === 'core');
    const profileCopy = await primary.getByTestId('tool-profile-settings').innerText();
    assert.match(profileCopy, /Toolset/);
    assert.match(profileCopy, /without autonomous skill discovery/);
    assert.doesNotMatch(profileCopy, /[\u3400-\u9fff]/);
    await context.writeArtifactJson('tool-profile-settings.json', {
      savedProfile: 'core', siblingFieldsPreserved: true, secondClientObserved: true,
      englishCopy: profileCopy,
    });

    await primary.screenshot({
      path: context.pathInArtifacts("context-settings-primary.png"),
      fullPage: true,
    });
    await secondary.screenshot({
      path: context.pathInArtifacts("context-settings-secondary.png"),
      fullPage: true,
    });
    await context.writeArtifactJson(
      "workspace-context-settings-persistence.json",
      {
        clientPreferences: {
          primaryTerminalContextInjection: false,
          secondaryTerminalContextInjection: true,
          primaryPersonality: "friendly",
          secondaryPersonality: "friendly",
        },
        sharedInstructions: {
          visibleInSecondProfile: true,
          explicitClearVisibleInSecondProfile: true,
        },
        diagnostics,
      },
    );
    assert.deepEqual(diagnostics, []);
    await secondaryContext.close();

    return {
      primaryClientPreferencesPersistedAfterReload: true,
      clientPreferencesIsolatedAcrossBrowserProfiles: true,
      runtimePersonalitySharedAcrossBrowserProfiles: true,
      runtimeInstructionsSharedAcrossBrowserProfiles: true,
      explicitInstructionClearPersisted: true,
    };
  },
);

async function login(page, gateway) {
  const response = await page.goto(gateway.baseUrl, {
    waitUntil: "domcontentloaded",
  });
  assert.equal(response?.status(), 200);
  const input = page.locator('input[name="token"]');
  if (await input.count()) {
    await input.fill(gateway.authToken);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith("/login"), {
        timeout: 30_000,
      }),
      page.locator('button[type="submit"]').click(),
    ]);
  }
  await page
    .getByTestId("desktop-sidebar")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function openContextSettings(page, gateway) {
  await page.goto(new URL("/settings/personal/context", gateway.baseUrl).href, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByTestId("context-settings-page")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByTestId("context-studio-instructions-textarea")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function assertSwitch(locator, expected) {
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  await assertEventually(
    async () =>
      (await locator.getAttribute("aria-checked")) === String(expected),
  );
}

async function saveInstructions(page) {
  const button = page.getByTestId("context-studio-instructions-save-button");
  await button.click();
  await assertEventually(async () => {
    if (await page.getByTestId("context-studio-instructions-error").count()) return false;
    return (await button.innerText()).includes("已保存") && (await button.isDisabled());
  });
}

async function assertPersonality(page, expectedLabel) {
  const select = page.getByTestId("codex-personality-select");
  await assertEventually(
    async () => (await select.textContent())?.includes(expectedLabel) === true,
  );
}

async function assertInstructions(page, expected) {
  const input = page.getByTestId("context-studio-instructions-textarea");
  await assertEventually(async () => (await input.inputValue()) === expected);
}

async function assertEventually(predicate, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("等待界面状态更新超时");
}

function observe(page, diagnostics, label) {
  page.on("pageerror", (error) =>
    diagnostics.push(`${label} pageerror: ${error.message}`),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      diagnostics.push(`${label} console: ${message.text()}`);
  });
}
