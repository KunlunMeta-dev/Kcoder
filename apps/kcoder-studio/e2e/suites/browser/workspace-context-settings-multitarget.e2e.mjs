import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(
  import.meta.url,
  {
    testId: "workspace-context-settings-explicit-multitarget-isolation",
    tier: "browser-real-app-server",
    modelPolicy:
      "no model turn; two isolated real KCoder app-servers behind one Gateway",
    retainSuccessLogs: true,
  },
  async (context) => {
    const { path: workspaceA } = await materializeWorkspace(
      context,
      "minimal",
      {
        instanceId: "context-target-a",
      },
    );
    const { path: workspaceB } = await materializeWorkspace(
      context,
      "minimal",
      {
        instanceId: "context-target-b",
      },
    );
    const targetA = await createTarget(
      context,
      "server-a",
      "Context Target A",
      workspaceA,
    );
    const targetB = await createTarget(
      context,
      "server-b",
      "Context Target B",
      workspaceB,
    );
    const serversFile = await context.writeStateJson("servers.json", [
      targetA,
      targetB,
    ]);
    const gateway = await startGateway(context, {
      label: "context-multitarget-gateway",
      workspace: workspaceA,
      serversFile,
      auth: true,
    });
    const chromium = await startChromium(context, {
      label: "context-multitarget-chromium",
    });
    const diagnostics = [];
    const primaryContext = await chromium.browser.newContext({
      viewport: { width: 1280, height: 820 },
    });
    const primary = await primaryContext.newPage();
    observe(primary, diagnostics, "primary");
    await login(primary, gateway);
    await openContextSettings(primary, gateway);

    const targetSelect = primary.getByTestId("context-runtime-target-select");
    await targetSelect.waitFor({ state: "visible", timeout: 30_000 });
    assert.deepEqual(
      await targetSelect
        .locator("option")
        .evaluateAll((options) =>
          options.map((option) => ({
            value: option.value,
            text: option.textContent,
          })),
        ),
      [
        { value: "server-a", text: "Context Target A (server-a)" },
        { value: "server-b", text: "Context Target B (server-b)" },
      ],
    );

    await selectTarget(primary, "server-a");
    await setInstructions(primary, "CONTEXT_ONLY_TARGET_A");
    await setPersonality(primary, "friendly", "亲和");

    await selectTarget(primary, "server-b");
    await assertInstructions(primary, "");
    await assertPersonality(primary, "务实");
    await setInstructions(primary, "CONTEXT_ONLY_TARGET_B");

    await selectTarget(primary, "server-a");
    await assertInstructions(primary, "CONTEXT_ONLY_TARGET_A");
    await assertPersonality(primary, "亲和");

    await primary.reload({ waitUntil: "domcontentloaded" });
    await primary
      .getByTestId("context-settings-page")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await primary.getByTestId("context-runtime-target-select").inputValue(),
      "server-a",
    );
    await assertInstructions(primary, "CONTEXT_ONLY_TARGET_A");
    await assertPersonality(primary, "亲和");

    const secondaryContext = await chromium.browser.newContext({
      viewport: { width: 1024, height: 760 },
    });
    const secondary = await secondaryContext.newPage();
    observe(secondary, diagnostics, "secondary");
    await login(secondary, gateway);
    await openContextSettings(secondary, gateway);
    assert.equal(
      await secondary.getByTestId("context-runtime-target-select").inputValue(),
      "server-a",
    );
    await assertInstructions(secondary, "CONTEXT_ONLY_TARGET_A");
    await assertPersonality(secondary, "亲和");
    await selectTarget(secondary, "server-b");
    await assertInstructions(secondary, "CONTEXT_ONLY_TARGET_B");
    await assertPersonality(secondary, "务实");

    const mobileContext = await chromium.browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
    });
    const mobile = await mobileContext.newPage();
    observe(mobile, diagnostics, "mobile");
    await loginMobile(mobile, gateway);
    await openMobileContextSettings(mobile, gateway);
    assert.equal(
      await mobile.getByTestId("context-runtime-target-select").inputValue(),
      "server-a",
    );
    await assertInstructions(mobile, "CONTEXT_ONLY_TARGET_A");
    await selectTarget(mobile, "server-b");
    await assertInstructions(mobile, "CONTEXT_ONLY_TARGET_B");
    await assertPersonality(mobile, "务实");

    await primary.screenshot({
      path: context.pathInArtifacts("context-multitarget-primary.png"),
      fullPage: true,
    });
    await secondary.screenshot({
      path: context.pathInArtifacts("context-multitarget-secondary.png"),
      fullPage: true,
    });
    await mobile.screenshot({
      path: context.pathInArtifacts("context-multitarget-mobile.png"),
      fullPage: true,
    });
    assert.deepEqual(diagnostics, []);
    await context.writeArtifactJson("context-multitarget-isolation.json", {
      targets: {
        "server-a": {
          instructions: "CONTEXT_ONLY_TARGET_A",
          personality: "friendly",
        },
        "server-b": {
          instructions: "CONTEXT_ONLY_TARGET_B",
          personality: "pragmatic",
        },
      },
      reloadRestoredDefaultTarget: true,
      secondBrowserProfileReadBothTargets: true,
      narrowMobileReadBothTargets: true,
      diagnostics,
    });
    await secondaryContext.close();
    await mobileContext.close();
    return {
      explicitTargetSelector: true,
      isolatedInstructions: true,
      isolatedPersonality: true,
      reloadRestored: true,
      secondBrowserProfileReadBothTargets: true,
      narrowMobileReadBothTargets: true,
    };
  },
);

async function createTarget(context, id, label, workspace) {
  const configDir = context.pathInState(`config-${id}`);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson(`config-${id}/settings.json`, {});
  await context.writeStateJson(`config-${id}/credentials.json`, {});
  const settingsFile = await context.writeStateJson(`settings-${id}.json`, {});
  const command = context.pathInState(`kcoder-${id}`);
  await writeFile(
    command,
    [
      "#!/bin/sh",
      `export KCODER_CONFIG_DIR='${shellQuote(configDir)}'`,
      `exec '${shellQuote(resolve(repoRoot, "target/debug/kcoder"))}' "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(command, 0o700);
  return {
    id,
    label,
    runtime: "kcoder",
    transport: "local",
    command,
    workspace,
    settingsFile,
  };
}

async function login(page, gateway) {
  const response = await page.goto(gateway.baseUrl, {
    waitUntil: "domcontentloaded",
  });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 30_000,
    }),
    page.locator('button[type="submit"]').click(),
  ]);
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

async function loginMobile(page, gateway) {
  const response = await page.goto(gateway.baseUrl, {
    waitUntil: "domcontentloaded",
  });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 30_000,
    }),
    page.locator('button[type="submit"]').click(),
  ]);
  // Completion of the login URL does not mean the Workbench/Gateway shim finished
  // initial startup. Wait for the mobile layout to mount before changing the settings
  // route so route initialization cannot overwrite premature navigation.
  await page
    .locator(
      '[data-testid="mobile-empty-header"], [data-testid="mobile-conversation-header"]',
    )
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function openMobileContextSettings(page, gateway) {
  await page.goto(new URL("/settings", gateway.baseUrl).href, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByTestId("mobile-settings-page")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("mobile-settings-personal-button").click();
  await page.getByTestId("mobile-settings-context-button").click();
  await page
    .getByTestId("mobile-context-settings-page")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByTestId("context-runtime-target-select")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function selectTarget(page, deviceId) {
  const select = page.getByTestId("context-runtime-target-select");
  if ((await select.inputValue()) !== deviceId)
    await select.selectOption(deviceId);
  await assertEventually(async () => (await select.inputValue()) === deviceId);
  await page
    .getByTestId("context-studio-instructions-textarea")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function setInstructions(page, value) {
  const input = page.getByTestId("context-studio-instructions-textarea");
  await input.fill(value);
  const button = page.getByTestId("context-studio-instructions-save-button");
  await button.click();
  await assertEventually(
    async () =>
      (await button.innerText()).includes("已保存") &&
      (await button.isDisabled()),
  );
}

async function setPersonality(page, value, expectedLabel) {
  await page.getByTestId("codex-personality-select").click();
  await page.getByTestId(`codex-personality-option-${value}`).click();
  await assertPersonality(page, expectedLabel);
}

async function assertInstructions(page, expected) {
  const input = page.getByTestId("context-studio-instructions-textarea");
  await assertEventually(async () => (await input.inputValue()) === expected);
}

async function assertPersonality(page, expectedLabel) {
  const select = page.getByTestId("codex-personality-select");
  await assertEventually(
    async () => (await select.textContent())?.includes(expectedLabel) === true,
  );
}

async function assertEventually(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("等待多目标 Context 状态更新超时");
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

function shellQuote(value) {
  return value.replaceAll("'", "'\\''");
}
