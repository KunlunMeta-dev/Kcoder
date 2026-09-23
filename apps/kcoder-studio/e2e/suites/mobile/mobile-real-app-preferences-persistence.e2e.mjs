import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
const preferenceKey = "kcoder-studio:mobile-app-preferences:v1";
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-app-preferences-reload-cross-profile-client-isolation-corruption",
  tier: "full-integration",
  modelPolicy: "model-independent real Gateway settings flow",
  retainSuccessLogs: true,
}, async context => {
  const workspaceA = context.pathInState("workspace-a");
  const workspaceB = context.pathInState("workspace-b");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  const gatewayA = await startGateway(context, {
    auth: true,
    label: "mobile-app-preferences-a",
    workspace: workspaceA,
    env: { KCODER_STUDIO_SCENARIO: "full-turn", KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const gatewayB = await startGateway(context, {
    auth: true,
    label: "mobile-app-preferences-b",
    workspace: workspaceB,
    env: {
      KCODER_STUDIO_SCENARIO: "full-turn",
      KCODER_STUDIO_WEB_ROOT: mobileDist,
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: gatewayA.baseUrl,
    },
  });
  const chromium = await startChromium(context, { label: "mobile-app-preferences-chromium" });
  const primaryContext = chromium.browser.contexts()[0];
  const page = await primaryContext.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  observe(page, diagnostics);

  await connectPhysicalOrigin(page, gatewayA);
  const profileA = profileFromUrl(page.url());
  await openSettings(page);
  const hiddenExecutionSettings = {
    plugins: await page.getByText("插件", { exact: true }).count(),
    defaultModel: await page.getByText("默认模型", { exact: true }).count(),
  };
  assert.deepEqual(hiddenExecutionSettings, { plugins: 0, defaultModel: 0 },
    "Mobile 设置不应暴露无法由 app-server 持久化的插件或默认模型入口");
  const themeState = {
    dark: await accessibilityState(page.getByRole("button", { name: "深色", exact: true })),
    light: await accessibilityState(page.getByRole("button", { name: "浅色（即将推出）", exact: true })),
    system: await accessibilityState(page.getByRole("button", { name: "系统（即将推出）", exact: true })),
  };
  const selected50kState = await selectScrollback(page, "50,000");
  if (selected50kState.ariaChecked !== "true" || themeState.dark.ariaPressed !== "true") {
    await context.writeArtifactJson("mobile-real-app-preferences-a11y-failure.json", { selected50kState, themeState });
  }
  assert.equal(selected50kState.ariaChecked, "true", "role=radio 的选中状态必须通过 aria-checked 暴露");
  assert.equal(themeState.dark.ariaPressed, "true", "当前主题按钮必须通过 aria-pressed 暴露选中状态");
  assert.equal(themeState.light.ariaDisabled, "true");
  assert.equal(themeState.system.ariaDisabled, "true");
  assert.match(await terminalSettings(page).innerText(), /50,000 行回滚/);
  assert.deepEqual(JSON.parse(await page.evaluate(key => localStorage.getItem(key), preferenceKey)), { terminalScrollbackLines: 50_000 });

  await page.getByText("添加 Gateway", { exact: true }).click();
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gatewayB.baseUrl);
  await page.getByTestId("gateway-token").fill(gatewayB.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  const profileB = profileFromUrl(page.url());
  assert.notEqual(profileA, profileB);
  await openSettings(page);
  assert.match(await terminalSettings(page).innerText(), /50,000 行回滚/,
    "app-level preference 必须跨 Gateway profile 共享");
  await selectScrollback(page, "100,000");

  const profiles = await readProfiles(page);
  const storedA = profiles.find(profile => profile.id === profileA);
  assert.ok(storedA);
  await page.getByLabel(`切换到 ${storedA.label}`).and(page.locator(":visible")).click();
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  await openSettings(page);
  assert.match(await terminalSettings(page).innerText(), /100,000 行回滚/);
  await page.reload({ waitUntil: "domcontentloaded" });
  await terminalSettings(page).waitFor({ state: "visible", timeout: 30_000 });
  assert.match(await terminalSettings(page).innerText(), /100,000 行回滚/,
    "刷新后必须从当前 Web 客户端存储恢复 app-level preference");

  const isolatedContext = await chromium.browser.newContext({ viewport: { width: 390, height: 844 } });
  const isolatedPage = await isolatedContext.newPage();
  const isolatedDiagnostics = [];
  observe(isolatedPage, isolatedDiagnostics);
  await connectPhysicalOrigin(isolatedPage, gatewayA);
  await openSettings(isolatedPage);
  assert.match(await terminalSettings(isolatedPage).innerText(), /10,000 行回滚/,
    "另一浏览器 profile 不应继承当前客户端的 app-level preference");
  assert.equal(await isolatedPage.evaluate(key => localStorage.getItem(key), preferenceKey), null);

  const corruptedContext = await chromium.browser.newContext({ viewport: { width: 390, height: 844 } });
  await corruptedContext.addInitScript(({ key }) => {
    if (sessionStorage.getItem("kcoder-e2e-corruption-seeded") !== "1") {
      localStorage.setItem(key, "{not-valid-json");
      sessionStorage.setItem("kcoder-e2e-corruption-seeded", "1");
    }
  }, { key: preferenceKey });
  const corruptedPage = await corruptedContext.newPage();
  const corruptedDiagnostics = [];
  observe(corruptedPage, corruptedDiagnostics);
  await connectPhysicalOrigin(corruptedPage, gatewayA);
  await openSettings(corruptedPage);
  assert.match(await terminalSettings(corruptedPage).innerText(), /10,000 行回滚/,
    "损坏的 app preference JSON 必须安全回退默认值");
  assert.equal(await corruptedPage.evaluate(key => localStorage.getItem(key), preferenceKey), "{not-valid-json");

  const clampedContext = await chromium.browser.newContext({ viewport: { width: 390, height: 844 } });
  await clampedContext.addInitScript(({ key }) => {
    if (sessionStorage.getItem("kcoder-e2e-clamp-seeded") !== "1") {
      localStorage.setItem(key, JSON.stringify({ terminalScrollbackLines: 999_999 }));
      sessionStorage.setItem("kcoder-e2e-clamp-seeded", "1");
    }
  }, { key: preferenceKey });
  const clampedPage = await clampedContext.newPage();
  const clampedDiagnostics = [];
  observe(clampedPage, clampedDiagnostics);
  await connectPhysicalOrigin(clampedPage, gatewayA);
  await openSettings(clampedPage);
  assert.match(await terminalSettings(clampedPage).innerText(), /100,000 行回滚/,
    "越界的 app preference 必须在真实 hydration 中钳制到安全上限");

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(isolatedDiagnostics, []);
  assert.deepEqual(corruptedDiagnostics, []);
  assert.deepEqual(clampedDiagnostics, []);
  await context.writeArtifactJson("mobile-real-app-preferences-persistence.json", {
    gateways: { a: gatewayA.baseUrl, b: gatewayB.baseUrl },
    profiles: { a: profileA, b: profileB },
    primaryStoredValue: await page.evaluate(key => localStorage.getItem(key), preferenceKey),
    isolatedClientStoredValue: await isolatedPage.evaluate(key => localStorage.getItem(key), preferenceKey),
    corruptedClientStoredValue: await corruptedPage.evaluate(key => localStorage.getItem(key), preferenceKey),
    clampedClientStoredValue: await clampedPage.evaluate(key => localStorage.getItem(key), preferenceKey),
    semantics: {
      sharedAcrossGatewayProfiles: true,
      survivesReload: true,
      isolatedAcrossBrowserProfiles: true,
      corruptedJsonFallsBackToDefault: true,
      outOfRangeValueClamped: true,
      executionSettingsOwnedByAppServer: true,
    },
    hiddenExecutionSettings,
    diagnostics: { primary: diagnostics, isolated: isolatedDiagnostics, corrupted: corruptedDiagnostics, clamped: clampedDiagnostics },
  });
  await isolatedContext.close();
  await corruptedContext.close();
  await clampedContext.close();
  return {
    realGatewayProfiles: true,
    crossProfileAppPreference: true,
    reloadPersistence: true,
    browserProfileIsolation: true,
    corruptionRecovery: true,
    outOfRangeClamp: true,
  };
});

function observe(page, output) {
  page.on("pageerror", error => output.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) output.push(`${message.type()}: ${message.text()}`);
  });
}

async function accessibilityState(locator) {
  return {
    role: await locator.getAttribute("role"),
    ariaPressed: await locator.getAttribute("aria-pressed"),
    ariaSelected: await locator.getAttribute("aria-selected"),
    ariaDisabled: await locator.getAttribute("aria-disabled"),
    tabIndex: await locator.getAttribute("tabindex"),
  };
}

async function selectScrollback(page, label) {
  await terminalSettings(page).click();
  const dialog = page.locator('[role="dialog"][aria-label="终端设置"]:visible');
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const option = dialog.getByRole("radio", { name: label, exact: true });
  await option.click();
  await page.waitForTimeout(100);
  const state = {
    label,
    role: await option.getAttribute("role"),
    ariaChecked: await option.getAttribute("aria-checked"),
    ariaSelected: await option.getAttribute("aria-selected"),
  };
  await dialog.getByLabel("关闭", { exact: true }).click();
  return state;
}

async function openSettings(page) {
  const direct = page.getByLabel("设置", { exact: true }).and(page.locator(":visible"));
  if (await direct.count()) {
    await direct.first().click();
  } else {
    await page.locator('[aria-label="打开任务列表"]:visible').click();
    await page.locator('[aria-label="设置"]:visible').click();
  }
  await terminalSettings(page).waitFor({ state: "visible", timeout: 30_000 });
}

function terminalSettings(page) {
  return page.locator('[data-testid="terminal-settings"]:visible');
}

async function connectPhysicalOrigin(page, gateway) {
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

function profileFromUrl(url) {
  const profileId = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean)[1] ?? "");
  assert.ok(profileId, `URL 缺少 profileId: ${url}`);
  return profileId;
}

async function readProfiles(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") ?? "null")?.profiles ?? []);
}
