import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { fingerprintRegularTree } from "../harness/settings-fingerprints.mjs";

// Focused product-build acceptance. No dependency snapshot, model call or native claim.
const webRoot = process.env.KCODER_E2E_SETTINGS_WEB_ROOT;
assert.ok(webRoot && isAbsolute(webRoot), "set an absolute built Mobile Web root");
const configuredKcoderBin = process.env.KCODER_E2E_KCODER_BIN;
assert.ok(!configuredKcoderBin || isAbsolute(configuredKcoderBin), "KCODER_E2E_KCODER_BIN must be an absolute binary path");
const kcBin = configuredKcoderBin ? resolve(configuredKcoderBin) : resolve(repoRoot, "target/release/kcoder");
const preferencesKey = "kcoder-studio:mobile-app-preferences:v1";

await runE2E(import.meta.url, {
  testId: "mobile-settings-hub-manual-browser",
  tier: "manual-live",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 30_000,
  modelPolicy: "real Mobile Web and owned authenticated Gateway; no model request or server configuration write",
}, async context => {
  const manifestBytes = await waitFor(async () => {
    try { return await readFile(resolve(webRoot, "kcoder-mobile-web.json")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }, 45 * 60_000, "requested product build manifest", 1000, context.abortSignal);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.version, 1);
  const sourceBefore = JSON.parse(await readFile(resolve(dirname(webRoot), "mobile-source-before.json")));
  const sourceAfterBytes = await waitFor(async () => {
    try { return await readFile(resolve(dirname(webRoot), "mobile-source-after.json")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }, 60_000, "product build source verification", 1000, context.abortSignal);
  const sourceAfter = JSON.parse(sourceAfterBytes);
  assert.ok(Array.isArray(sourceBefore.entries), "Mobile source provenance must use the regular-tree inventory format");
  assert.match(sourceBefore.digest ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(sourceAfter, sourceBefore, "Mobile source inventory must not change during the product build");
  const requiredSettingsFiles = ["app/settings.tsx", "app/settings-section.tsx"];
  for (const file of requiredSettingsFiles) {
    assert.ok(sourceBefore.entries.some(entry => entry.path === file), `Mobile source inventory must include src/${file}`);
  }
  for (const entry of sourceBefore.entries) {
    assert.ok(entry.path && !isAbsolute(entry.path) && !entry.path.split("/").includes(".."));
    assert.match(entry.sha256 ?? "", /^[a-f0-9]{64}$/);
  }
  const currentMobileSource = await fingerprintRegularTree(resolve(repoRoot, "apps/kcoder-studio/mobile/src"));
  assert.deepEqual(currentMobileSource, sourceBefore,
    "current Mobile source inventory must match the product build's complete source binding");
  for (const file of manifest.files) {
    assert.ok(!file.path.startsWith("/") && !file.path.split("/").includes(".."));
    const bytes = await readFile(resolve(webRoot, file.path));
    assert.equal(bytes.length, file.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const serversFile = await context.writeStateJson("servers.json", [
    { id: "local", label: "Settings acceptance", transport: "local", workspace },
  ]);
  const gateway = await startGateway(context, {
    label: "settings-hub-gateway", auth: true, workspace, serversFile,
    kcoderBin: kcBin,
    env: { KCODER_STUDIO_WEB_ROOT: webRoot, KCODER_STUDIO_MOBILE_WEB_ROOT: webRoot },
  });
  const chromium = await startChromium(context, {
    label: "settings-hub-chromium", noSandbox: true, startTimeoutMs: 60_000,
  });
  const browserContext = await chromium.browser.newContext({
    locale: "zh-CN", colorScheme: "light", deviceScaleFactor: 2,
    viewport: { width: 390, height: 1180 },
  });
  const page = await browserContext.newPage();
  const errors = [];
  const sessionReceipts = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (response.request().method() === "POST" && new URL(response.url()).pathname === "/api/mobile/session") sessionReceipts.push(response.status());
  });
  const visible = id => page.locator(`[data-testid="${id}"]:visible`);
  const screenshot = async name => {
    const path = context.pathInArtifacts(name);
    await page.screenshot({ path });
    await chmod(path, 0o600);
  };
  await page.goto(`${gateway.baseUrl}/login?returnTo=%2Fmobile%2F`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await page.locator('button[type="submit"]').click();
  await visible("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await visible("welcome-direct-connection").click();
  await visible("gateway-endpoint").fill(gateway.baseUrl);
  await visible("gateway-token").fill(gateway.authToken);
  await visible("gateway-connect").click();
  await visible("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  assert.ok(sessionReceipts.includes(200), "must pair through real Gateway authentication");
  await page.goto(`${gateway.baseUrl}/mobile/settings`, { waitUntil: "domcontentloaded" });
  await visible("settings-home").waitFor({ state: "visible", timeout: 30_000 });
  await screenshot("settings-home-390-zh-light.png");
  await context.writeArtifactJson("screenshot-ready.json", { screenshot: "settings-home-390-zh-light.png" });

  // Exercise actual navigation and persistence before taking the remaining views.
  await visible("settings-appearance").click();
  await visible("settings-appearance-screen").waitFor({ state: "visible" });
  await visible("settings-theme-row").click();
  await visible("settings-theme-choice-dark").click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await visible("settings-appearance-screen").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).theme, preferencesKey), "dark");
  await page.waitForFunction(() => document.documentElement.style.colorScheme === "dark");
  await visible("settings-detail-back").click();
  await visible("settings-home").waitFor({ state: "visible" });
  await screenshot("settings-home-390-zh-dark.png");

  const homeRows = await visible("settings-home").locator('[data-testid][role="button"]').evaluateAll(nodes =>
    nodes.map(node => node.dataset.testid).filter(id => id !== "settings-detail-back"));
  const destinations = [
    ["settings-manage-connections", "settings-connections", "settings-connections-screen"],
    ["settings-section-models_services", "settings-section", "settings-section-screen", "models_services"],
    ["settings-section-execution_permissions", "settings-section", "settings-section-screen", "execution_permissions"],
    ["settings-appearance", "settings-appearance", "settings-appearance-screen"],
    ["settings-section-conversation_preferences", "settings-section", "settings-section-screen", "conversation_preferences"],
    ["settings-section-quick_phrases", "settings-section", "settings-section-screen", "quick_phrases"],
    ["settings-section-custom_instructions", "settings-section", "settings-section-screen", "custom_instructions"],
    ["settings-section-tool_configuration", "settings-section", "settings-section-screen", "tool_configuration"],
    ["settings-section-plugins_skills", "settings-section", "settings-section-screen", "plugins_skills"],
    ["settings-section-usage", "settings-section", "settings-section-screen", "usage"],
    ["settings-section-storage_cache", "settings-section", "settings-section-screen", "storage_cache"],
    ["terminal-settings", "settings-terminal", "settings-terminal-screen"],
    ["diagnostics-settings", "settings-diagnostics", "settings-diagnostics-screen"],
    ["settings-about", "settings-about", "settings-about-screen"],
  ];
  assert.deepEqual(homeRows, destinations.map(([id]) => id), "all fourteen entries must appear in the requested order");
  for (const id of homeRows) {
    const [, route, screen, section] = destinations.find(([row]) => row === id);
    await visible(id).scrollIntoViewIfNeeded();
    await visible(id).click();
    await visible("settings-home").waitFor({ state: "hidden" });
    await visible(screen).waitFor({ state: "visible" });
    const destination = new URL(page.url());
    assert.equal(destination.origin, gateway.baseUrl);
    assert.ok(destination.pathname.endsWith(`/${route}`), `${id} must open its own detail route`);
    if (section) assert.equal(destination.searchParams.get("section"), section);
    await visible("settings-detail-back").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${id} overflow`);
    await visible("settings-detail-back").click();
    await visible("settings-home").waitFor({ state: "visible" });
  }
  await page.goto(`${gateway.baseUrl}/mobile/settings-section?section=browser`, { waitUntil: "domcontentloaded" });
  await visible("settings-section-screen").waitFor({ state: "visible", timeout: 15_000 });
  assert.match(await visible("settings-section-screen").innerText(), /unavailable|不可用/i,
    "the removed Browser settings deep link must show the unavailable route");
  assert.equal(await visible("settings-browser-open").count(), 0,
    "Settings must not create a standalone Browser session screen");
  await page.goto(`${gateway.baseUrl}/mobile/settings`, { waitUntil: "domcontentloaded" });
  await visible("settings-home").waitFor({ state: "visible", timeout: 15_000 });
  const observations = [];
  for (const language of ["zh-CN", "en"]) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(({ key, language, theme }) => {
        const old = JSON.parse(localStorage.getItem(key));
        localStorage.setItem(key, JSON.stringify({ ...old, language, theme }));
      }, { key: preferencesKey, language, theme });
      await page.reload({ waitUntil: "domcontentloaded" });
      await visible("settings-home").waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForFunction(expected => document.documentElement.style.colorScheme === expected, theme);
      assert.equal(await visible("settings-home-title").innerText(), language === "en" ? "Settings" : "设置");
      assert.equal(await page.locator("html").getAttribute("lang"), language);
      assert.equal(await visible("settings-home").evaluate(node => getComputedStyle(node).backgroundColor),
        theme === "light" ? "rgb(244, 244, 245)" : "rgb(24, 24, 27)");
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 1180 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const rows = await visible("settings-home").locator('[data-testid][role="button"]').evaluateAll(nodes =>
          nodes.filter(node => node.dataset.testid !== "settings-detail-back").map(node => ({
            id: node.dataset.testid, height: node.getBoundingClientRect().height,
            right: node.getBoundingClientRect().right, text: node.innerText,
            clippedText: Array.from(node.querySelectorAll("div, span")).filter(element =>
              Array.from(element.childNodes).some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim()) &&
              getComputedStyle(element).overflow === "hidden" && element.scrollWidth > element.clientWidth + 1,
            ).map(element => element.textContent),
          })));
        assert.deepEqual(rows.map(row => row.id), destinations.map(([id]) => id));
        for (const row of rows) {
          assert.ok(row.height >= 44 && row.height <= 64, `${row.id} must remain compact and touch accessible`);
          assert.ok(row.right <= width, `${row.id} must fit narrow screens`);
          assert.ok(!row.text.includes("settings_hub."), "translation key leaked into UI");
          assert.deepEqual(row.clippedText, [], `${row.id} labels and summaries must fit without truncation`);
        }
        await screenshot(`settings-home-${width}-${language}-${theme}.png`);
        observations.push({ language, theme, width, rows });
      }
    }
  }
  assert.deepEqual(errors, []);
  assert.equal(createHash("sha256").update(await readFile(resolve(webRoot, "kcoder-mobile-web.json"))).digest("hex"),
    createHash("sha256").update(manifestBytes).digest("hex"));
  return { sessionExchangeOk: true, homeRows: homeRows.length, observations, errors,
    sourceBefore, webRoot, manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    serverConfigurationEditingExercised: false, devicePreferenceWrites: true, modelRequestIssuedByTest: false,
    nativeValidation: false, frozenDependencyIntegration: false };
});
