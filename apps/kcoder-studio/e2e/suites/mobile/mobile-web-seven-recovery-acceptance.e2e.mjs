import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { startMobileGatewayAliasProxy } from "../../harness/mobile-gateway-alias-proxy.mjs";
import {
  repoRoot,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";
import {
  buildGatewayMobileWebManifest,
  writeGatewayMobileWebManifest,
} from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";

const PREFERENCES_KEY = "kcoder-studio:mobile-app-preferences:v1";
const UNKNOWN_ROUTE = "__mobile-seven-recovery-unknown-route__";
const GATEWAY_BINARY = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");

process.umask(0o077);

await runE2E(import.meta.url, {
  testId: "mobile-web-seven-issues-isolated-browser-acceptance",
  tier: "full-integration",
  modelPolicy: "model-independent actual Expo Mobile Web export, isolated authenticated Gateway and Relay path alias; session/catalog HTTP failures are explicitly injected; no Provider or model calls, personal profile, shared preview port, or native-device claim",
  retainSuccessEvidence: true,
  retainSuccessLogs: true,
  evidenceReason: "Exercise seven Mobile Web recovery and route behaviors through user-visible entry points at narrow phone widths with direct and Relay mounts, plus one targeted wide Sessions recovery layout check",
}, async run => {
  let lastExportPhase;
  const mobileWeb = await exportMobileWeb(run, {
    label: "mobile-seven-recovery-export",
    outputName: "mobile-seven-recovery-mobile-web",
    dependencyRoot: process.env.KCODER_E2E_MOBILE_DEPENDENCY_ROOT || undefined,
    deployMount: true,
    timeoutMs: 10 * 60 * 1000,
    onProgress: progress => {
      if (!progress?.phase || progress.phase === lastExportPhase) return;
      lastExportPhase = progress.phase;
      const elapsedMs = Number.isFinite(progress.elapsedMs) ? Math.max(0, Math.round(progress.elapsedMs)) : null;
      process.stdout.write(`${JSON.stringify({ stage: "mobile-web-export", phase: progress.phase, elapsedMs })}\n`);
    },
  });
  const manifest = await buildGatewayMobileWebManifest(mobileWeb.path, {
    expectedFiles: mobileWeb.bundleFiles,
  });
  await writeGatewayMobileWebManifest(mobileWeb.path, manifest);

  const configDir = run.pathInState("config");
  const workspace = run.pathInState("empty-target-workspace");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await run.writeStateJson("config/settings.json", {});
  const serversFile = await run.writeStateJson("servers.json", [
    {
      id: "owned-acceptance-target",
      label: "Owned acceptance target",
      transport: "local",
      command: GATEWAY_BINARY,
      workspace,
    },
  ]);

  const alias = await startMobileGatewayAliasProxy(run, {
    label: "mobile-seven-recovery-relay-alias",
    aliases: ["a", "b"],
  });
  const gateway = await startGateway(run, {
    auth: true,
    label: "mobile-seven-recovery-gateway",
    workspace,
    serversFile,
    kcoderBin: GATEWAY_BINARY,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_MOBILE_WEB_ROOT: mobileWeb.path,
      KCODER_STUDIO_PUBLIC_ORIGINS: alias.origin,
    },
  });
  alias.setGateway(gateway);

  const browser = await startChromium(run, {
    label: "mobile-seven-recovery-chromium",
    startTimeoutMs: 60_000,
  });
  const screenshots = [];
  const diagnostics = [];
  const routeEvidence = [];

  const capture = async (page, name, scenario) => {
    await assertNoHorizontalOverflow(page, `${scenario}/${name}`);
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(120);
    const path = run.pathInArtifacts(`${name}.png`);
    await page.screenshot({ path, animations: "disabled" });
    screenshots.push({ name, path, ...scenario });
  };
  const newPhonePage = async ({ width, height = 844, language, theme }) => {
    const page = await browser.newPage({ viewport: { width, height }, locale: language, colorScheme: theme });
    page.on("pageerror", error => diagnostics.push({ route: new URL(page.url()).pathname, error: error.message }));
    await page.addInitScript(({ key, preference }) => {
      localStorage.setItem(key, JSON.stringify(preference));
    }, {
      key: PREFERENCES_KEY,
      preference: { language, theme },
    });
    return page;
  };
  const visible = (page, testId) => page.locator(`[data-testid="${testId}"]:visible`);

  const recoveryPage = await newPhonePage({ width: 390, language: "zh-CN", theme: "light" });
  await recoveryPage.goto(`${gateway.baseUrl}/mobile/h/missing-profile-recovery`, { waitUntil: "domcontentloaded" });
  await waitFor(async () => {
    const text = await recoveryPage.locator("body").innerText().catch(() => "");
    return text.trim().length > 0 ? true : null;
  }, 30_000, "fresh-profile deep link recovery renders");
  await assertRouteTitle(recoveryPage, "主页 · KCoder Mobile", "fresh-profile deep-link route title");
  const missingProfileText = await recoveryPage.locator("body").innerText();
  assert.match(missingProfileText, /(?:未保存|未存储).{0,24}(?:连接|网关)|(?:连接|网关).{0,24}(?:未保存|未存储)/,
    "a missing local profile must be described as an unsaved connection");
  assert.doesNotMatch(missingProfileText, /(?:不可用|已删除|无法连接)/,
    "a missing local profile must not claim that the Gateway is unavailable or removed");
  await visible(recoveryPage, "missing-profile-pair-gateway").waitFor({ state: "visible", timeout: 10_000 });
  await visible(recoveryPage, "missing-profile-manual-connection").waitFor({ state: "visible", timeout: 10_000 });
  await visible(recoveryPage, "missing-profile-settings").waitFor({ state: "visible", timeout: 10_000 });
  await capture(recoveryPage, "missing-profile-recovery-390-zh-light", { width: 390, language: "zh-CN", theme: "light", mount: "direct" });
  await visible(recoveryPage, "missing-profile-manual-connection").click();
  await visible(recoveryPage, "gateway-endpoint").waitFor({ state: "visible", timeout: 20_000 });
  routeEvidence.push({ case: "fresh-profile-deep-link", outcome: "neutral missing-connection state with pairing, settings, and a working manual-connection action" });

  const historyMissingPage = await newPhonePage({ width: 320, language: "en", theme: "dark" });
  await historyMissingPage.goto(`${gateway.baseUrl}/mobile/sessions`, { waitUntil: "domcontentloaded" });
  await waitFor(async () => (await historyMissingPage.locator("body").innerText().catch(() => "")).trim().length ? true : null,
    30_000, "history missing-profile state renders");
  await visible(historyMissingPage, "sessions-no-active-profile").waitFor({ state: "visible", timeout: 20_000 });
  const missingHistoryText = await historyMissingPage.locator("body").innerText();
  assert.match(missingHistoryText, /not saved|connect|pair|connection/i,
    "history without a saved profile must explain the missing connection and recovery path");
  assert.doesNotMatch(missingHistoryText, /Loading history…|Loading conversations…|Loading\.\.\./,
    "history without a saved profile must settle into an actionable state");
  await visible(historyMissingPage, "sessions-pair-gateway").waitFor({ state: "visible" });
  await visible(historyMissingPage, "sessions-manual-gateway").waitFor({ state: "visible" });
  await capture(historyMissingPage, "history-missing-profile-320-en-dark", { width: 320, language: "en", theme: "dark", mount: "direct" });
  await visible(historyMissingPage, "sessions-manual-gateway").click();
  await visible(historyMissingPage, "gateway-endpoint").waitFor({ state: "visible", timeout: 20_000 });
  routeEvidence.push({ case: "history-without-profile", outcome: "settled empty-profile state with pairing and manual-connect actions; manual action opens the connection form" });

  const directPage = await newPhonePage({ width: 390, language: "zh-CN", theme: "light" });
  let serverCatalogAttempts = 0;
  let emptyCatalogResponses = 0;
  let initialServersSuppressed = false;
  let allowServerCatalog = false;
  await directPage.route(url => new URL(url).origin === gateway.baseUrl && new URL(url).pathname === "/api/mobile/session", async route => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    assert.equal(payload.capabilities?.mobileInitialServersV1, true,
      "the isolated Gateway should advertise its real initial server snapshot before this scenario disables that optimization");
    assert.ok(Array.isArray(payload.initialServers?.servers),
      "the isolated Gateway should return a real initial server snapshot before this scenario disables that optimization");
    delete payload.capabilities.mobileInitialServersV1;
    delete payload.initialServers;
    initialServersSuppressed = true;
    await route.fulfill({ response, json: payload });
  });
  await directPage.route(url => new URL(url).origin === gateway.baseUrl && new URL(url).pathname === "/api/servers", async route => {
    serverCatalogAttempts += 1;
    if (!allowServerCatalog) {
      await route.fulfill({ status: 503, contentType: "text/plain; charset=utf-8", body: "temporary server catalog fault" });
      return;
    }
    emptyCatalogResponses += 1;
    await route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify({ servers: [] }) });
  });
  const homeResponse = await directPage.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  assert.equal(homeResponse?.status(), 200, "the real Gateway must serve the deploy-mounted Mobile export");
  await visible(directPage, "welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await visible(directPage, "welcome-direct-connection").click();
  await visible(directPage, "gateway-endpoint").fill(gateway.baseUrl);
  await visible(directPage, "gateway-token").fill(gateway.authToken);
  await visible(directPage, "gateway-connect").click();
  await visible(directPage, "home-interface-modern").waitFor({ state: "visible", timeout: 45_000 });
  profileIdFromMountedHome(directPage.url(), "/mobile");
  await waitFor(() => serverCatalogAttempts > 0 ? true : null, 20_000, "the paired profile requests its server catalog");
  assert.equal(initialServersSuppressed, true,
    "the browser fixture must suppress the successful pairing bootstrap so the inventory failure is observed through GET /api/servers");
  assert.equal(await directPage.evaluate(() => document.documentElement.lang), "zh-CN");
  await assertRouteTitle(directPage, "主页 · KCoder Mobile", "paired Mobile default route title");
  routeEvidence.push({ case: "direct-pairing", outcome: "real isolated Gateway session exchange with its initial-inventory optimization explicitly suppressed so GET /api/servers drives history recovery" });

  await visible(directPage, "sessions").click();
  await assertRouteTitle(directPage, "历史 · KCoder Mobile", "Chinese history route title");
  await visible(directPage, "sessions-server-inventory-error").waitFor({ state: "visible", timeout: 20_000 });
  await visible(directPage, "sessions-retry-server-inventory").waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await visible(directPage, "sessions-server-inventory-loading").count(), 0,
    "a failed server inventory must settle instead of retaining its loading state");
  const failedHistoryText = await directPage.locator("body").innerText();
  assert.match(failedHistoryText, /(?:加载|历史|会话|server|history|conversation|retry|重试)/i,
    "history must explain the failed server-list precondition");
  assert.doesNotMatch(failedHistoryText, /Loading history…|Loading conversations…|Loading\.\.\./,
    "history precondition failure must settle into readable recovery instead of a spinner");
  await capture(directPage, "history-server-catalog-fault-390-zh-light", { width: 390, language: "zh-CN", theme: "light", mount: "direct" });
  allowServerCatalog = true;
  await visible(directPage, "sessions-retry-server-inventory").click();
  await visible(directPage, "sessions-list").waitFor({ state: "visible", timeout: 30_000 });
  await visible(directPage, "sessions-empty-state").waitFor({ state: "visible", timeout: 10_000 });
  assert.ok(serverCatalogAttempts >= 2, "history retry must request the failed server catalog again");
  assert.ok(emptyCatalogResponses >= 1, "inventory retry must settle with the controlled empty server catalog");
  await capture(directPage, "history-server-catalog-recovered-390-zh-light", { width: 390, language: "zh-CN", theme: "light", mount: "direct" });

  const modelRequests = [];
  const targetlessPage = await newPhonePage({ width: 390, language: "zh-CN", theme: "light" });
  targetlessPage.on("request", request => {
    if (/\/rpc(?:\?|$)|\/api\/providers|\/api\/models/.test(request.url())) modelRequests.push(request.url());
  });
  const settingsResponse = await targetlessPage.goto(`${gateway.baseUrl}/mobile/settings`, { waitUntil: "domcontentloaded" });
  assert.equal(settingsResponse?.status(), 200, "the isolated Gateway must serve the direct settings route");
  await visible(targetlessPage, "settings-home").waitFor({ state: "visible", timeout: 30_000 });
  await assertRouteTitle(targetlessPage, "设置 · KCoder Mobile", "Chinese settings route title");
  await visible(targetlessPage, "settings-section-models_services").click();
  await visible(targetlessPage, "model-services-settings").waitFor({ state: "visible", timeout: 20_000 });
  await assertRouteTitle(targetlessPage, "模型与服务 · KCoder Mobile", "Chinese models route title");
  await visible(targetlessPage, "models-open-connections").waitFor({ state: "visible", timeout: 20_000 });
  await waitFor(async () => await targetlessPage.getByText("请先在上方选择运行目标", { exact: false }).count() > 0 ? true : null,
    10_000, "model settings shows the no-target state");
  await targetlessPage.waitForTimeout(600);
  const modelSettingsText = await visible(targetlessPage, "model-services-settings").innerText();
  assert.doesNotMatch(modelSettingsText, /Refreshing…|正在刷新|Loading|正在加载|加载中/i,
    "a missing target must not be reported as refreshing or loading model services");
  assert.equal(await visible(targetlessPage, "model-services-settings").getByRole("progressbar").count(), 0,
    "no-target model settings must not leave an accessible loading indicator");
  assert.deepEqual(modelRequests, [], "no target must not open an RPC/provider request");
  await capture(targetlessPage, "model-services-no-target-390-zh-light", { width: 390, language: "zh-CN", theme: "light", mount: "direct" });
  routeEvidence.push({ case: "models-without-target", outcome: "no-target state settled without a false refresh or RPC" });

  const englishTitlePage = await newPhonePage({ width: 320, language: "en", theme: "dark" });
  const englishSettingsResponse = await englishTitlePage.goto(`${gateway.baseUrl}/mobile/settings`, { waitUntil: "domcontentloaded" });
  assert.equal(englishSettingsResponse?.status(), 200, "the isolated Gateway must serve English settings routes");
  await visible(englishTitlePage, "settings-home").waitFor({ state: "visible", timeout: 30_000 });
  await assertRouteTitle(englishTitlePage, "Settings · KCoder Mobile", "English settings route title");
  await visible(englishTitlePage, "settings-section-models_services").click();
  await visible(englishTitlePage, "model-services-settings").waitFor({ state: "visible", timeout: 20_000 });
  await assertRouteTitle(englishTitlePage, "Models & APIs · KCoder Mobile", "English models route title");
  await visible(englishTitlePage, "settings-detail-back").click();
  await visible(englishTitlePage, "settings-home").waitFor({ state: "visible", timeout: 20_000 });
  await visible(englishTitlePage, "settings-section-tool_configuration").click();
  await visible(englishTitlePage, "settings-section-screen").waitFor({ state: "visible", timeout: 20_000 });
  await assertRouteTitle(englishTitlePage, "Tool settings · KCoder Mobile", "English tool-settings route title");
  await capture(englishTitlePage, "tool-settings-title-320-en-dark", { width: 320, language: "en", theme: "dark", mount: "direct" });
  routeEvidence.push({ case: "english-route-titles", outcome: "Settings, Models & APIs, and Tool settings titles follow actual navigation in English" });

  await visible(targetlessPage, "settings-detail-back").click();
  await visible(targetlessPage, "settings-home").waitFor({ state: "visible", timeout: 20_000 });
  await visible(targetlessPage, "settings-section-tool_configuration").click();
  await waitFor(async () => await visible(targetlessPage, "settings-section-screen").count() > 0 ? true : null,
    20_000, "tool configuration settings route renders");
  await assertRouteTitle(targetlessPage, "工具配置 · KCoder Mobile", "Chinese tool-configuration route title");
  await visible(targetlessPage, "settings-detail-back").click();
  await visible(targetlessPage, "settings-home").waitFor({ state: "visible", timeout: 20_000 });
  await visible(targetlessPage, "settings-section-models_services").click();
  await visible(targetlessPage, "model-services-settings").waitFor({ state: "visible", timeout: 20_000 });
  await visible(targetlessPage, "models-open-connections").click();
  await visible(targetlessPage, "settings-connections-screen").waitFor({ state: "visible", timeout: 20_000 });
  await assertRouteTitle(targetlessPage, "连接与设备 · KCoder Mobile", "Chinese connection settings route title");
  await visible(targetlessPage, "settings-add-gateway").click();
  await visible(targetlessPage, "gateway-endpoint").waitFor({ state: "visible", timeout: 20_000 });
  await visible(targetlessPage, "gateway-token").waitFor({ state: "visible", timeout: 10_000 });
  await capture(targetlessPage, "add-gateway-opens-manual-form-390-zh-light", { width: 390, language: "zh-CN", theme: "light", mount: "direct" });
  const pairingToken = `${Math.random().toString(36).slice(2)}-fixed-404-fixture`;
  run.registerSecret(pairingToken);
  let sessionExchangeFaults = 0;
  await targetlessPage.route(url => new URL(url).origin === gateway.baseUrl && new URL(url).pathname === "/api/mobile/session", async route => {
    if (route.request().method() === "POST" && sessionExchangeFaults === 0) {
      sessionExchangeFaults += 1;
      await route.fulfill({ status: 404, contentType: "text/plain; charset=utf-8", body: "404 Not Found" });
      return;
    }
    await route.continue();
  });
  await visible(targetlessPage, "gateway-endpoint").fill(gateway.baseUrl);
  await visible(targetlessPage, "gateway-token").fill(pairingToken);
  await visible(targetlessPage, "gateway-connect").click();
  await visible(targetlessPage, "gateway-http-error").waitFor({ state: "visible", timeout: 20_000 });
  const pairingError = await visible(targetlessPage, "gateway-http-error").allInnerTexts();
  assert.equal(sessionExchangeFaults, 1, "the owned session exchange fault must occur exactly once");
  assert.ok(pairingError.join(" ").trim().length > 8, "the failed exchange must provide readable recovery copy");
  assert.match(pairingError.join(" "), /未找到 Gateway|检查 Gateway 地址/,
    "the 404 must map to the localized endpoint-recovery message");
  assert.doesNotMatch(pairingError.join(" "), /404 Not Found|HTTP\s*404/i,
    "the client must not expose the raw HTTP status as its recovery message");
  assert.equal(await visible(targetlessPage, "gateway-http-error-status").count(), 0,
    "the raw HTTP status remains collapsed until a user requests details");
  await capture(targetlessPage, "session-exchange-404-friendly-error-390-zh-light", { width: 390, language: "zh-CN", theme: "light", mount: "direct" });
  await visible(targetlessPage, "gateway-http-error-details-toggle").click();
  await visible(targetlessPage, "gateway-http-error-status").waitFor({ state: "visible", timeout: 5_000 });
  assert.match(await visible(targetlessPage, "gateway-http-error-status").innerText(), /404/,
    "the technical status is available only after an explicit details action");
  await visible(targetlessPage, "gateway-http-error-details-toggle").click();
  await visible(targetlessPage, "gateway-http-error-status").waitFor({ state: "hidden", timeout: 5_000 });
  routeEvidence.push({ case: "session-exchange-404", outcome: "one injected plain-text 404 rendered as localized user-facing recovery copy" });

  const directUnknownPage = await newPhonePage({ width: 320, language: "en", theme: "dark" });
  const directSyntheticToken = `synthetic-direct-${Math.random().toString(36).slice(2)}`;
  run.registerSecret(directSyntheticToken);
  await directUnknownPage.goto(`${gateway.baseUrl}/mobile/${UNKNOWN_ROUTE}?token=${encodeURIComponent(directSyntheticToken)}#synthetic-fragment`, { waitUntil: "domcontentloaded" });
  await assertUnknownRouteAndReturn(directUnknownPage, {
    mountPrefix: "/mobile",
    expectedTitle: /not found|page not found/i,
    expectedDocumentTitle: "Page not found · KCoder Mobile",
    screenshot: "direct-unmatched-route-320-en-dark",
    scenario: { width: 320, language: "en", theme: "dark", mount: "direct" },
    capture,
  });

  const relayUnknownPage = await newPhonePage({ width: 390, language: "en", theme: "dark" });
  const relaySyntheticToken = `synthetic-relay-${Math.random().toString(36).slice(2)}`;
  run.registerSecret(relaySyntheticToken);
  await relayUnknownPage.goto(`${alias.mobileEntryUrl("a")}${UNKNOWN_ROUTE}?token=${encodeURIComponent(relaySyntheticToken)}#synthetic-fragment`, { waitUntil: "domcontentloaded" });
  await assertUnknownRouteAndReturn(relayUnknownPage, {
    mountPrefix: "/g/a/mobile",
    expectedTitle: /not found|page not found/i,
    expectedDocumentTitle: "Page not found · KCoder Mobile",
    screenshot: "relay-unmatched-route-390-en-dark",
    scenario: { width: 390, language: "en", theme: "dark", mount: "/g/a/mobile" },
    capture,
  });
  routeEvidence.push({ case: "unmatched-routes", outcome: "direct and Relay mounts display safe error pages and preserve their mount prefixes on Home return" });

  const wideHistoryPage = await newPhonePage({ width: 1280, height: 720, language: "zh-CN", theme: "light" });
  const wideHistoryResponse = await wideHistoryPage.goto(`${gateway.baseUrl}/mobile/sessions`, { waitUntil: "domcontentloaded" });
  assert.equal(wideHistoryResponse?.status(), 200, "the isolated Gateway must serve wide-screen history recovery");
  await visible(wideHistoryPage, "sessions-no-active-profile").waitFor({ state: "visible", timeout: 30_000 });
  await visible(wideHistoryPage, "sessions-pair-gateway").waitFor({ state: "visible", timeout: 10_000 });
  await visible(wideHistoryPage, "sessions-manual-gateway").waitFor({ state: "visible", timeout: 10_000 });
  const wideRecoveryActionsWidth = await visible(wideHistoryPage, "sessions-manual-gateway")
    .evaluate(element => element.parentElement?.getBoundingClientRect().width ?? null);
  assert.equal(typeof wideRecoveryActionsWidth, "number", "wide history recovery must expose a measurable actions container");
  assert.ok(wideRecoveryActionsWidth <= 441,
    `wide history recovery actions must stay within the 440px content cap; measured ${wideRecoveryActionsWidth}px`);
  await capture(wideHistoryPage, "history-no-profile-1280x720-zh-light", {
    width: 1280,
    height: 720,
    language: "zh-CN",
    theme: "light",
    mount: "direct",
  });
  routeEvidence.push({ case: "wide-history-recovery-layout", outcome: "fresh no-profile history action group stays within the 440px content cap at 1280x720" });

  assert.deepEqual(diagnostics, [], "Mobile routes must not emit uncaught page errors");
  await run.writeArtifactJson("mobile-web-seven-recovery-acceptance.json", {
    passed: true,
    scope: "Actual full Expo Mobile Web deploy-mount export, isolated Gateway pairing, one path-alias Relay mount, and owned HTTP fault injection. No external model request, personal profile, or native-device claim; the ephemeral pairing profile stayed in the owned browser storage.",
    viewportLocaleThemeCases: [
      { width: 390, language: "zh-CN", theme: "light" },
      { width: 320, language: "en", theme: "dark" },
      { width: 390, language: "en", theme: "dark" },
    ],
    wideScreenRecoveryCheck: {
      width: 1280,
      height: 720,
      language: "zh-CN",
      theme: "light",
      actionsMaxWidth: 440,
      measuredActionsWidth: wideRecoveryActionsWidth,
    },
    routeEvidence,
    screenshots: screenshots.map(({ name, width, height, language, theme, mount }) => ({ name, width, height, language, theme, mount })),
    serverCatalogAttempts,
    emptyCatalogResponses,
    initialServersSuppressed,
    sessionExchangeFaults,
    modelRequests: modelRequests.length,
    diagnostics,
    expectedExternalCalls: 0,
  });
  return {
    routeCases: routeEvidence.length,
    screenshots: screenshots.length,
    serverCatalogAttempts,
    emptyCatalogResponses,
    sessionExchangeFaults,
    modelRequests: modelRequests.length,
    viewportLocaleThemeCases: 3,
    wideScreenRecoveryActionsWidth: wideRecoveryActionsWidth,
  };
});

async function assertUnknownRouteAndReturn(page, {
  mountPrefix,
  expectedTitle,
  expectedDocumentTitle,
  screenshot,
  scenario,
  capture,
}) {
  const visible = (targetPage, testId) => targetPage.locator(`[data-testid="${testId}"]:visible`);
  await visible(page, "mobile-not-found-screen").waitFor({ state: "visible", timeout: 20_000 });
  const missingText = await visible(page, "mobile-not-found-title").innerText();
  assert.match(missingText, expectedTitle, `${mountPrefix} unknown route must show a readable not-found state`);
  const renderedPath = await visible(page, "mobile-not-found-path").textContent();
  assert.ok(renderedPath?.includes(`${mountPrefix}/${UNKNOWN_ROUTE}`),
    `${mountPrefix} not-found UI must display the mounted pathname`);
  assert.doesNotMatch(renderedPath ?? "", /[?#]|token|synthetic|secret/i,
    `${mountPrefix} not-found UI must not display query, fragment, or secret-like data`);
  await assertRouteTitle(page, expectedDocumentTitle, `${mountPrefix} not-found document title`);
  await waitFor(async () => await page.evaluate(() => document.documentElement.lang) === "en" ? true : null,
    10_000, `${mountPrefix} English locale is reflected in the document language`);
  const homeAction = visible(page, "mobile-not-found-home");
  await homeAction.waitFor({ state: "visible", timeout: 20_000 });
  await capture(page, screenshot, scenario);
  await homeAction.click();
  await waitFor(() => {
    const path = new URL(page.url()).pathname;
    return (path === mountPrefix || path.startsWith(`${mountPrefix}/`)) && path !== `${mountPrefix}/${UNKNOWN_ROUTE}` ? true : null;
  }, 15_000, `${mountPrefix} Home action preserves the deployment mount and leaves the unmatched route`);
  await visible(page, "welcome-direct-connection").waitFor({ state: "visible", timeout: 20_000 });
  await assertNoHorizontalOverflow(page, `${mountPrefix}/home-return`);
}

async function assertRouteTitle(page, expected, label) {
  await waitFor(async () => {
    const title = await page.title();
    return title === expected ? true : null;
  }, 15_000, `${label} is reflected in document.title`);
  assert.equal(await page.title(), expected, `${label} must use the exact localized route and product title`);
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, `${label} must not overflow horizontally`);
}

function profileIdFromMountedHome(rawUrl, mountPrefix) {
  const path = new URL(rawUrl).pathname;
  const prefix = `${mountPrefix}/h/`;
  assert.ok(path.startsWith(prefix), `pairing must land on the expected mounted profile route: ${path}`);
  const profileId = decodeURIComponent(path.slice(prefix.length).split("/", 1)[0] || "");
  assert.ok(profileId, "the paired profile route must contain a profile ID");
  return profileId;
}
