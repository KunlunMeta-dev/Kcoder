import assert from "node:assert/strict";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(import.meta.url, {
  testId: "workspace-quick-phrases-defaults-modes-client-persistence",
  tier: "browser-real-app-server",
  modelPolicy: "no model turn; isolated real Gateway and app-server",
  retainSuccessLogs: true,
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, "minimal", {
    instanceId: "workspace-quick-phrases",
  });
  const gateway = await startGateway(context, {
    label: "workspace-quick-phrases-gateway",
    workspace,
    auth: true,
  });
  const chromium = await startChromium(context, { label: "workspace-quick-phrases-chromium" });
  const browserContext = await chromium.browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await browserContext.newPage();
  const diagnostics = [];
  observe(page, diagnostics, "primary");

  await login(page, gateway);
  await openFirstBlankProject(page);
  const defaultPhrases = await openQuickPhraseMenu(page);
  assert.deepEqual(defaultPhrases, [
    "default-summary-progress",
    "default-create-plan",
    "default-pursue-goal",
  ]);

  const composer = page.getByTestId("chat-message-input");
  await page.getByTestId("quick-phrase-option-default-create-plan").click();
  await page.getByTestId("plan-mode-pill").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await composer.textContent())?.trim(), "分析需求并制定详细的实施计划");
  await page.getByTestId("cancel-plan-mode-button").click({ force: true });
  await clearComposer(page, composer);

  await page.getByTestId("quick-phrase-button").click();
  await page.getByTestId("manage-quick-phrases-button").click();
  await page.getByTestId("quick-phrases-settings-page").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("add-quick-phrase-button").click();
  await page.getByTestId("quick-phrase-title-input").fill("E2E 持续目标");
  await page.getByTestId("quick-phrase-content-input").fill("QUICK_PHRASE_GOAL_CONTENT");
  await page.getByTestId("quick-phrase-mode-goal").check();
  await page.getByTestId("quick-phrase-save-button").click();
  await page.getByTestId("quick-phrase-title-input").waitFor({ state: "detached", timeout: 10_000 });
  await page.waitForFunction(() => {
    const value = JSON.parse(localStorage.getItem("kcoder-studio:app-preferences") || "{}");
    return value.quickPhrases?.some(phrase => phrase.title === "E2E 持续目标");
  });

  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
  await openFirstBlankProject(page);
  await page.getByTestId("quick-phrase-button").click();
  const customOption = page.getByRole("option").filter({ hasText: "E2E 持续目标" });
  await customOption.waitFor({ state: "visible", timeout: 10_000 });
  await customOption.click();
  await page.getByTestId("goal-draft-pill").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await page.getByTestId("chat-message-input").textContent())?.trim(), "QUICK_PHRASE_GOAL_CONTENT");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
  await openFirstBlankProject(page);
  await page.getByTestId("quick-phrase-button").click();
  await page.getByRole("option").filter({ hasText: "E2E 持续目标" }).waitFor({ state: "visible", timeout: 10_000 });

  await page.getByTestId("manage-quick-phrases-button").click();
  await page.getByTestId("quick-phrases-settings-page").waitFor({ state: "visible", timeout: 30_000 });
  page.on("dialog", dialog => void dialog.accept());
  const deleteButtons = page.locator('[data-testid^="quick-phrase-delete-"]');
  while (await deleteButtons.count()) {
    const before = await deleteButtons.count();
    await deleteButtons.first().click();
    await page.waitForFunction(expected => {
      const value = JSON.parse(localStorage.getItem("kcoder-studio:app-preferences") || "{}");
      return value.quickPhrases?.length === expected;
    }, before - 1);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("quick-phrases-settings-page").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.locator('[data-testid^="quick-phrase-delete-"]').count(), 0);
  assert.deepEqual(await page.evaluate(() =>
    JSON.parse(localStorage.getItem("kcoder-studio:app-preferences") || "{}").quickPhrases
  ), []);
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
  await openFirstBlankProject(page);
  await page.getByTestId("quick-phrase-button").click();
  assert.equal(await page.locator('[data-testid^="quick-phrase-option-"]').count(), 0, "explicit empty list must not restore defaults");

  const secondContext = await chromium.browser.newContext({ viewport: { width: 1024, height: 720 } });
  const secondPage = await secondContext.newPage();
  observe(secondPage, diagnostics, "secondary");
  await login(secondPage, gateway);
  await openFirstBlankProject(secondPage);
  const secondDefaults = await openQuickPhraseMenu(secondPage);
  assert.deepEqual(secondDefaults, defaultPhrases);
  assert.equal(await secondPage.getByRole("option").filter({ hasText: "E2E 持续目标" }).count(), 0);
  assert.equal(
    await secondPage.evaluate(() => localStorage.getItem("kcoder-studio:app-preferences")),
    null,
    "new browser profile should receive defaults without inheriting another client's UI preferences",
  );
  await secondContext.close();

  await page.screenshot({ path: context.pathInArtifacts("quick-phrases-persisted.png"), fullPage: true });
  await context.writeArtifactJson("workspace-quick-phrases-persistence.json", {
    defaultPhrases,
    secondDefaults,
    customPhrase: { title: "E2E 持续目标", content: "QUICK_PHRASE_GOAL_CONTENT", mode: "goal" },
    explicitEmptyListPersisted: true,
    clientIsolation: true,
    diagnostics,
  });
  assert.deepEqual(diagnostics, []);
  return {
    canonicalDefaultsVisible: true,
    planModeApplied: true,
    customGoalPersistedAfterReload: true,
    explicitEmptyListPersistedAfterReload: true,
    preferencesIsolatedAcrossBrowserProfiles: true,
  };
});

function observe(page, diagnostics, label) {
  page.on("pageerror", error => diagnostics.push(`${label} pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error") diagnostics.push(`${label} console: ${message.text()}`);
  });
}

async function login(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  const input = page.locator('input[name="token"]');
  if (await input.count()) {
    await input.fill(gateway.authToken);
    await Promise.all([
      page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 30_000 }),
      page.locator('button[type="submit"]').click(),
    ]);
  }
  await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
}

async function openFirstBlankProject(page) {
  const project = page.getByTestId("project-item").first();
  await project.waitFor({ state: "visible", timeout: 30_000 });
  await project.hover();
  await project.getByTestId("project-new-conversation-button").click();
  await page.getByTestId("chat-message-input").waitFor({ state: "visible", timeout: 30_000 });
}

async function openQuickPhraseMenu(page) {
  await page.getByTestId("quick-phrase-button").click();
  await page.getByTestId("quick-phrase-option-default-summary-progress").waitFor({ state: "visible", timeout: 10_000 });
  return page.locator('[data-testid^="quick-phrase-option-default-"]').evaluateAll(options =>
    options.map(option => option.getAttribute("data-testid")?.replace("quick-phrase-option-", "")),
  );
}

async function clearComposer(page, composer) {
  await composer.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  assert.equal((await composer.textContent())?.trim(), "");
}
