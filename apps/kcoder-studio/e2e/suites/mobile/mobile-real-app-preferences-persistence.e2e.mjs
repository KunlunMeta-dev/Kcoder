import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const preferenceKey = "kcoder-studio:mobile-app-preferences:v1";
const kcoderBinary = process.env.KCODER_E2E_KCODER_BIN
  ? resolve(repoRoot, process.env.KCODER_E2E_KCODER_BIN)
  : resolve(repoRoot, "target/debug/kcoder");

await runE2E(import.meta.url, {
  testId: "mobile-web-real-language-theme-preferences-draft-profile-persistence",
  tier: "full-integration",
  modelPolicy: "model-independent real Expo Web and Gateway UI; the local full-turn app-server scenario supplies deterministic task bootstrap without an external model request",
}, async context => {
  const mobileWeb = await exportMobileWeb(context, {
    label: "mobile-appearance-expo-web-export",
    outputName: "mobile-web-export",
    dependencyRoot: process.env.KCODER_E2E_MOBILE_DEPENDENCY_ROOT || undefined,
    timeoutMs: 10 * 60 * 1000,
  });
  await recordDependencyPinProvenance(context, mobileWeb);
  const workspaceA = context.pathInState("workspace-a");
  const workspaceB = context.pathInState("workspace-b");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });

  // The Gateway, mobile session exchange, app-server RPC and visible app are real.
  // Its local `full-turn` scenario only replaces external model behavior so this
  // preference and draft test does not make a provider request.
  const gatewayA = await startGateway(context, {
    auth: true,
    label: "mobile-app-preferences-a",
    workspace: workspaceA,
    kcoderBin: kcoderBinary,
    env: {
      KCODER_STUDIO_SCENARIO: "full-turn",
      KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
    },
  });
  const gatewayB = await startGateway(context, {
    auth: true,
    label: "mobile-app-preferences-b",
    workspace: workspaceB,
    kcoderBin: kcoderBinary,
    env: {
      KCODER_STUDIO_SCENARIO: "full-turn",
      KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: gatewayA.baseUrl,
    },
  });
  const chromium = await startChromium(context, {
    label: "mobile-app-preferences-chromium",
    startTimeoutMs: 60_000,
  });
  const primaryContext = await chromium.browser.newContext({
    locale: "zh-CN",
    colorScheme: "dark",
    viewport: { width: 390, height: 844 },
  });
  const page = await primaryContext.newPage();
  const diagnostics = [];
  const transport = {
    sessionExchangeOrigins: new Set(),
    rpcOrigins: new Set(),
    rpcConnectionCount: 0,
    rpcInitializeRequestCount: 0,
    serverCatalogResponses: [],
    serverCatalogResponseTasks: [],
  };
  observe(page, diagnostics, context);
  observeGatewayTransport(page, transport);

  await connectPhysicalOrigin(page, gatewayA);
  const profileA = profileFromUrl(page.url());
  await waitForOrigin(transport.sessionExchangeOrigins, gatewayA.baseUrl, "profile A mobile session exchange", context);
  assert.equal(new URL(page.url()).origin, gatewayA.baseUrl);
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN",
    "system language must follow the isolated Chromium zh-CN locale");
  await assertResolvedTheme(page, "dark");

  await createTask(page, "MOBILE_APPEARANCE_PROFILE_A_BOOTSTRAP", context, profileA, gatewayA.baseUrl, transport, "profile-a-initial");
  const taskA = taskIdentityFromUrl(page.url());
  assert.equal(taskA.profileId, profileA);
  assert.equal(taskA.serverId, "local", "profile A task must use the server advertised by its real Gateway catalog");
  await waitForOrigin(transport.rpcOrigins, gatewayA.baseUrl, "profile A app-server RPC", context);
  const draftA = "MOBILE_APPEARANCE_PROFILE_A_UNSENT_DRAFT";
  await visibleTestId(page, "message-input").fill(draftA);
  await waitForDraftPersistence(page, draftA);

  const settingsDeepLinkPage = await primaryContext.newPage();
  await settingsDeepLinkPage.goto(`${gatewayA.baseUrl}/settings-appearance`, { waitUntil: "domcontentloaded" });
  await visibleTestId(settingsDeepLinkPage, "settings-appearance-screen").waitFor({ state: "visible", timeout: 30_000 });
  await visibleTestId(settingsDeepLinkPage, "settings-appearance-title").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(new URL(settingsDeepLinkPage.url()).pathname, "/settings-appearance");
  await visibleTestId(settingsDeepLinkPage, "settings-detail-back").click();
  await visibleTestId(settingsDeepLinkPage, "settings-home").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(new URL(settingsDeepLinkPage.url()).pathname, "/settings",
    "a cold Appearance route must fall back to Settings home when no navigation history exists");
  await settingsDeepLinkPage.close();

  await openSettings(page);
  await visibleTestId(page, "settings-home").waitFor({ state: "visible", timeout: 30_000 });
  await assertMainSettingsPlaceholdersHidden(page);
  await page.screenshot({ path: context.pathInArtifacts("settings-home-390-dark.png"), animations: "disabled" });
  await openSettingsDetail(page, "settings-about", "settings-about-screen", "settings-about-title", "/settings-about");
  await returnToSettingsHome(page);
  const settingsRpcBaseline = {
    websocketConnections: transport.rpcConnectionCount,
    initializeRequests: transport.rpcInitializeRequestCount,
  };
  assert.ok(settingsRpcBaseline.websocketConnections > 0,
    "the active task must have an observed real Gateway app-server WebSocket before changing preferences");
  assert.ok(settingsRpcBaseline.initializeRequests > 0,
    "the active task must have sent an observed app-server initialize request before changing preferences");
  assert.match(await terminalSettings(page).innerText(), /10,000 行/,
    "a new browser profile starts with the default terminal scrollback preference");
  const hiddenExecutionSettings = {
    plugins: await visibleText(page, "插件", { exact: true }).count(),
    defaultModel: await visibleText(page, "默认模型", { exact: true }).count(),
  };
  assert.deepEqual(hiddenExecutionSettings, { plugins: 0, defaultModel: 0 },
    "Mobile 设置不应暴露无法由 app-server 持久化的插件或默认模型入口");

  await openSettingsDetail(page, "settings-appearance", "settings-appearance-screen", "settings-appearance-title", "/settings-appearance");
  await page.screenshot({ path: context.pathInArtifacts("settings-appearance-system-390.png"), animations: "disabled" });
  const initialLanguage = await appearanceChoiceState(page, "language", "system");
  const initialTheme = {
    light: await appearanceChoiceState(page, "theme", "light"),
    dark: await appearanceChoiceState(page, "theme", "dark"),
    system: await appearanceChoiceState(page, "theme", "system"),
  };
  assert.equal(initialLanguage.ariaChecked, "true", "system language must be selected by default");
  assert.equal(initialTheme.system.ariaChecked, "true", "system theme must be selected by default");
  for (const state of [initialTheme.light, initialTheme.dark, initialTheme.system]) {
    assert.notEqual(state.ariaDisabled, "true", "all three theme choices must be operable");
    assert.equal(state.disabled, false);
  }

  await verifyCompactAppearanceControls(page, context);

  await selectLanguage(page, "en", "en");
  await returnToSettingsHome(page);
  await assertMainSettingsPlaceholdersHidden(page);
  await openSettingsDetail(page, "settings-appearance", "settings-appearance-screen", "settings-appearance-title", "/settings-appearance");
  await selectLanguage(page, "zh-CN", "zh-CN");
  await selectLanguage(page, "system", "zh-CN");
  await selectLanguage(page, "en", "en");

  await assertChoiceDismissalBehavior(page, "theme", "light");
  await assertChoiceDismissalBehavior(page, "language", "system");

  await selectTheme(page, "light");
  await waitForResolvedTheme(page, "light");
  await assertThemeSelection(page, "light");
  await returnToSettingsHome(page);
  await page.screenshot({ path: context.pathInArtifacts("settings-home-390-light.png"), animations: "disabled" });
  await openSettingsDetail(page, "settings-appearance", "settings-appearance-screen", "settings-appearance-title", "/settings-appearance");
  await page.screenshot({ path: context.pathInArtifacts("settings-appearance-light-390.png"), animations: "disabled" });

  await selectTheme(page, "dark");
  await waitForResolvedTheme(page, "dark");
  await assertThemeSelection(page, "dark");
  await page.screenshot({ path: context.pathInArtifacts("settings-appearance-dark-390.png"), animations: "disabled" });

  await selectTheme(page, "system");
  await waitForResolvedTheme(page, "dark");
  await assertThemeSelection(page, "system");
  await page.emulateMedia({ colorScheme: "light" });
  await waitForResolvedTheme(page, "light");
  await assertThemeSelection(page, "system");
  await page.emulateMedia({ colorScheme: "dark" });
  await waitForResolvedTheme(page, "dark");

  await returnToSettingsHome(page);
  const selected50kState = await selectScrollback(page, 50_000);
  assert.equal(selected50kState.ariaChecked, "true", "role=radio must expose the selected scrollback size");
  await waitForPreference(page, { language: "en", theme: "system", terminalScrollbackLines: 50_000 });
  const settingsRpcAfterPreferenceChanges = {
    websocketConnections: transport.rpcConnectionCount,
    initializeRequests: transport.rpcInitializeRequestCount,
  };
  assert.deepEqual(settingsRpcAfterPreferenceChanges, settingsRpcBaseline,
  "language, theme and terminal preference changes must not reconnect or reinitialize the app-server while the existing task is active");
  assert.deepEqual(await readPreferences(page), {
    language: "en",
    theme: "system",
    terminalScrollbackLines: 50_000,
  });

  await context.writeArtifactJson("mobile-appearance-screenshot-policy.json", {
    reason: "Retain small Chromium screenshots so reviewers can inspect Settings home, the 390px light and dark appearance pages, 320px choice sheets, and the connection page.",
    evidence: ["settings-home-390-dark.png", "settings-home-390-light.png", "settings-home-320-dark.png", "settings-home-320-light.png", "settings-appearance-system-390.png", "settings-appearance-light-390.png", "settings-appearance-dark-390.png", "settings-appearance-320.png", "settings-appearance-light-320.png", "settings-appearance-dark-320.png", "settings-theme-choice-320.png", "settings-language-choice-320.png", "settings-connections-390.png", "settings-connections-profiles-390.png", "settings-connections-profiles-320.png"],
    runtime: "Expo Web export served by this run's isolated Gateway in Chromium",
    nativeHermesOrPhysicalDevice: false,
    credentialsIncluded: false,
  });

  await closeSettings(page);
  assert.deepEqual(taskIdentityFromUrl(page.url()), taskA,
    "changing app appearance must return to the same active profile and task");
  assert.equal(await visibleTestId(page, "message-input").inputValue(), draftA,
    "opening and leaving Settings must keep the unsent composer draft");
  await page.reload({ waitUntil: "domcontentloaded" });
  await visibleTestId(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(expected => document.documentElement.lang === expected, "en");
  await assertResolvedTheme(page, "dark");
  assert.deepEqual(taskIdentityFromUrl(page.url()), taskA,
    "refresh must restore the same profile, server and thread route");
  assert.equal(await visibleTestId(page, "message-input").inputValue(), draftA,
    "refresh must restore the unsent draft in the same task");

  await openSettings(page);
  await assertPreferenceSelection(page, { language: "en", theme: "system" });
  await openSettingsDetail(page, "settings-manage-connections", "settings-connections-screen", "settings-connections-title", "/settings-connections");
  await visibleTestId(page, "settings-add-gateway").waitFor({ state: "visible", timeout: 10_000 });
  await page.screenshot({ path: context.pathInArtifacts("settings-connections-390.png"), animations: "disabled" });
  await visibleTestId(page, "settings-add-gateway").click();
  await visibleTestId(page, "welcome-direct-connection").click();
  await visibleTestId(page, "gateway-endpoint").fill(gatewayB.baseUrl);
  await visibleTestId(page, "gateway-token").fill(gatewayB.authToken);
  await visibleTestId(page, "gateway-connect").click();
  await visibleTestId(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  const profileB = profileFromUrl(page.url());
  assert.notEqual(profileA, profileB);
  assert.equal(new URL(page.url()).origin, gatewayA.baseUrl,
    "adding another target keeps the mobile Web app on its original browser origin");
  await waitForOrigin(transport.sessionExchangeOrigins, gatewayB.baseUrl, "profile B mobile session exchange", context);

  // Establish one independent B draft while the newly connected profile is already
  // active. The scenario below then tests profile round-trips and draft restoration,
  // without coupling appearance persistence to a second workspace-catalog reload.
  await createTask(page, "MOBILE_APPEARANCE_PROFILE_B_BOOTSTRAP", context, profileB, gatewayB.baseUrl, transport, "profile-b-initial");
  const taskB = taskIdentityFromUrl(page.url());
  assert.equal(taskB.profileId, profileB);
  assert.equal(taskB.serverId, "local", "profile B task must use the server advertised by its real Gateway catalog");
  await waitForOrigin(transport.rpcOrigins, gatewayB.baseUrl, "profile B app-server RPC", context);
  assert.equal(await visibleTestId(page, "message-input").inputValue(), "",
    "profile B must not inherit profile A's unsent draft");
  const draftB = "MOBILE_APPEARANCE_PROFILE_B_UNSENT_DRAFT";
  await visibleTestId(page, "message-input").fill(draftB);
  await waitForDraftPersistence(page, draftB);
  await waitFor(() => transport.serverCatalogResponses.find(response =>
    response.origin === new URL(gatewayB.baseUrl).origin && response.status === 200 && response.parsed && response.serverIds.includes("local")),
  10_000, "profile B Gateway server catalog includes local", 50, context.abortSignal);

  await openSettings(page);
  await assertPreferenceSelection(page, { language: "en", theme: "system" });
  assert.match(await terminalSettings(page).innerText(), /50,000 lines/,
    "app preferences are shared across Gateway profiles on the same mobile browser");
  await selectScrollback(page, 100_000);
  await waitForPreference(page, { language: "en", theme: "system", terminalScrollbackLines: 100_000 });
  await assertConnectionManagementProfileStates(page, context, profileA, profileB);
  await switchProfile(page, profileA);
  assert.equal(profileFromUrl(page.url()), profileA);
  await openTaskFromHome(page, taskA);
  assert.equal(await visibleTestId(page, "message-input").inputValue(), draftA,
    "switching away and back must keep profile A's draft attached to its original thread");

  await openSettings(page);
  await switchProfile(page, profileB);
  assert.equal(profileFromUrl(page.url()), profileB);
  await openTaskFromHome(page, taskB);
  assert.equal(await visibleTestId(page, "message-input").inputValue(), draftB,
    "switching to profile B must restore only its own unsent draft");

  await openSettings(page);
  await switchProfile(page, profileA);
  await openTaskFromHome(page, taskA);
  assert.equal(await visibleTestId(page, "message-input").inputValue(), draftA);
  await openSettings(page);
  await switchProfile(page, profileB);
  await openTaskFromHome(page, taskB);
  assert.equal(await visibleTestId(page, "message-input").inputValue(), draftB,
    "profile B must restore only its own draft after a profile round trip");
  await openSettings(page);
  await assertPreferenceSelection(page, { language: "en", theme: "system" });
  await assertResolvedTheme(page, "dark");
  await waitForPreference(page, { language: "en", theme: "system", terminalScrollbackLines: 100_000 });

  const isolatedContext = await chromium.browser.newContext({
    locale: "zh-CN",
    colorScheme: "light",
    viewport: { width: 390, height: 844 },
  });
  const isolatedPage = await isolatedContext.newPage();
  const isolatedDiagnostics = [];
  observe(isolatedPage, isolatedDiagnostics, context);
  await connectPhysicalOrigin(isolatedPage, gatewayA);
  await openSettings(isolatedPage);
  await assertPreferenceSelection(isolatedPage, { language: "system", theme: "system" });
  await assertResolvedTheme(isolatedPage, "light");
  assert.match(await terminalSettings(isolatedPage).innerText(), /10,000 行/,
    "a separate browser profile must start with default app preferences");
  assert.equal(await isolatedPage.evaluate(key => localStorage.getItem(key), preferenceKey), null);

  const corruptedContext = await chromium.browser.newContext({
    locale: "zh-CN",
    colorScheme: "light",
    viewport: { width: 390, height: 844 },
  });
  await corruptedContext.addInitScript(({ key }) => {
    if (sessionStorage.getItem("kcoder-e2e-corruption-seeded") !== "1") {
      localStorage.setItem(key, "{not-valid-json");
      sessionStorage.setItem("kcoder-e2e-corruption-seeded", "1");
    }
  }, { key: preferenceKey });
  const corruptedPage = await corruptedContext.newPage();
  const corruptedDiagnostics = [];
  observe(corruptedPage, corruptedDiagnostics, context);
  await connectPhysicalOrigin(corruptedPage, gatewayA);
  await openSettings(corruptedPage);
  await assertPreferenceSelection(corruptedPage, { language: "system", theme: "system" });
  await assertResolvedTheme(corruptedPage, "light");
  assert.match(await terminalSettings(corruptedPage).innerText(), /10,000 行/,
    "damaged preference JSON must safely fall back to defaults");
  assert.equal(await corruptedPage.evaluate(key => localStorage.getItem(key), preferenceKey), "{not-valid-json");

  const clampedContext = await chromium.browser.newContext({
    locale: "zh-CN",
    colorScheme: "light",
    viewport: { width: 390, height: 844 },
  });
  await clampedContext.addInitScript(({ key }) => {
    if (sessionStorage.getItem("kcoder-e2e-clamp-seeded") !== "1") {
      localStorage.setItem(key, JSON.stringify({ terminalScrollbackLines: 999_999 }));
      sessionStorage.setItem("kcoder-e2e-clamp-seeded", "1");
    }
  }, { key: preferenceKey });
  const clampedPage = await clampedContext.newPage();
  const clampedDiagnostics = [];
  observe(clampedPage, clampedDiagnostics, context);
  await connectPhysicalOrigin(clampedPage, gatewayA);
  await openSettings(clampedPage);
  await assertPreferenceSelection(clampedPage, { language: "system", theme: "system" });
  await assertResolvedTheme(clampedPage, "light");
  assert.match(await terminalSettings(clampedPage).innerText(), /100,000 行/,
    "out-of-range scrollback must clamp to its supported upper bound");

  await Promise.all(transport.serverCatalogResponseTasks);
  const catalogA = transport.serverCatalogResponses.find(response =>
    response.origin === new URL(gatewayA.baseUrl).origin && response.serverIds.includes("local"));
  const catalogB = transport.serverCatalogResponses.find(response =>
    response.origin === new URL(gatewayB.baseUrl).origin && response.serverIds.includes("local"));
  assert.ok(catalogA, "profile A's observed Gateway catalog must advertise local");
  assert.equal(catalogA.status, 200, "profile A's observed Gateway catalog must return HTTP 200");
  assert.ok(catalogB, "profile B's observed Gateway catalog must advertise local");
  assert.equal(catalogB.status, 200, "profile B's observed Gateway catalog must return HTTP 200");

  await context.writeArtifactJson("mobile-browser-console-diagnostics.json", {
    primary: diagnostics,
    isolated: isolatedDiagnostics,
    corrupted: corruptedDiagnostics,
    clamped: clampedDiagnostics,
  });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(isolatedDiagnostics, []);
  assert.deepEqual(corruptedDiagnostics, []);
  assert.deepEqual(clampedDiagnostics, []);
  assert.ok(transport.rpcOrigins.has(new URL(gatewayA.baseUrl).origin));
  assert.ok(transport.rpcOrigins.has(new URL(gatewayB.baseUrl).origin));
  assert.ok(transport.sessionExchangeOrigins.has(new URL(gatewayA.baseUrl).origin));
  assert.ok(transport.sessionExchangeOrigins.has(new URL(gatewayB.baseUrl).origin));

  await context.writeArtifactJson("mobile-real-app-preferences-persistence.json", {
    mobileWebExport: {
      sourceTreeSha256: mobileWeb.sourceTreeSha256,
      bundleSha256: mobileWeb.bundleSha256,
      bundleFileCount: mobileWeb.bundleFileCount,
    },
    gateways: { a: gatewayA.baseUrl, b: gatewayB.baseUrl },
    gatewayCatalogs: { a: catalogA, b: catalogB },
    browserOrigin: new URL(page.url()).origin,
    profiles: { a: profileA, b: profileB },
    tasks: { a: taskA, b: taskB },
    primaryStoredValue: await page.evaluate(key => localStorage.getItem(key), preferenceKey),
    isolatedClientStoredValue: await isolatedPage.evaluate(key => localStorage.getItem(key), preferenceKey),
    corruptedClientStoredValue: await corruptedPage.evaluate(key => localStorage.getItem(key), preferenceKey),
    clampedClientStoredValue: await clampedPage.evaluate(key => localStorage.getItem(key), preferenceKey),
    transport: {
      mobileSessionExchangeOrigins: [...transport.sessionExchangeOrigins].sort(),
      appServerRpcOrigins: [...transport.rpcOrigins].sort(),
      serverCatalogResponses: transport.serverCatalogResponses,
      activeTaskSettingsBaseline: settingsRpcBaseline,
      settingsRpcAfterPreferenceChanges,
      endOfScenario: {
        websocketConnections: transport.rpcConnectionCount,
        initializeRequests: transport.rpcInitializeRequestCount,
      },
      modelBoundary: "local deterministic full-turn app-server scenario; no external provider/model request",
    },
    semantics: {
      languageSelectionAndReloadPersistence: true,
      explicitLightAndDarkThemes: true,
      systemThemeTracksChromiumColorSchemeChanges: true,
      preferencesSharedAcrossGatewayProfilesOnOneBrowser: true,
      preferencesIsolatedAcrossBrowserProfiles: true,
      damagedJsonFallsBackToDefaults: true,
      outOfRangeScrollbackClamped: true,
      activeGatewayAndTaskIdentitySurviveRefresh: true,
      composerDraftPersistsPerProfileAndThread: true,
      executionSettingsOwnedByAppServer: true,
    },
    hiddenExecutionSettings,
    knownUnverifiedBoundaries: [
      "A prior run observed no visible server-option-local after reactivating Gateway profile B and opening /new. The cause was not established. This run creates the B task on B's initial activation and verifies A/B profile draft round-trips; it does not establish that post-reactivation catalog path.",
    ],
    diagnostics: {
      primary: diagnostics,
      isolated: isolatedDiagnostics,
      corrupted: corruptedDiagnostics,
      clamped: clampedDiagnostics,
    },
  });

  await isolatedContext.close();
  await corruptedContext.close();
  await clampedContext.close();
  await primaryContext.close();
  return {
    expoWebSourceExportedThisRun: true,
    realGatewayProfiles: 2,
    languagePersistence: true,
    explicitLightDarkAndSystemTheme: true,
    liveSystemColorSchemeChange: true,
    browserProfileIsolation: true,
    corruptionRecovery: true,
    outOfRangeClamp: true,
    perProfileThreadDrafts: true,
    priorPostReactivationNewWorkspaceCatalogPath: "unverified; previous observation and unresolved cause recorded in artifact",
    externalModelRequests: 0,
  };
});

function observe(page, output, context) {
  page.on("pageerror", error => appendDiagnostic(output, {
    kind: "pageerror",
    type: error.name || "Error",
    text: boundedDiagnosticText(context, error.message || String(error)),
    location: null,
  }));
  page.on("console", message => {
    if (!["error", "warning"].includes(message.type())) return;
    appendDiagnostic(output, {
      kind: "console",
      type: message.type(),
      text: boundedDiagnosticText(context, message.text()),
      location: safeConsoleLocation(message.location(), context),
    });
  });
}

function appendDiagnostic(output, diagnostic) {
  const maxDiagnostics = 50;
  if (output.length < maxDiagnostics) {
    output.push(diagnostic);
  } else if (output.length === maxDiagnostics) {
    output.push({ kind: "truncated", type: "diagnostic-limit", text: "More than 50 browser diagnostics were observed.", location: null });
  }
}

function boundedDiagnosticText(context, value) {
  const redacted = context.redactText(String(value)).replace(/https?:\/\/[^\s<>"']+/gi, candidate => {
    try {
      const url = new URL(candidate);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "[REDACTED-URL]";
    }
  });
  return {
    value: redacted.slice(0, 1_000),
    truncated: redacted.length > 1_000,
  };
}

function safeConsoleLocation(location, context) {
  if (typeof location?.url !== "string" || !location.url) return null;
  let url = "[unavailable]";
  try {
    const parsed = new URL(location.url);
    url = parsed.protocol === "http:" || parsed.protocol === "https:"
      ? `${parsed.origin}${parsed.pathname}`
      : `[${parsed.protocol}]`;
  } catch {
    // Keep malformed or non-URL console locations out of retained artifacts.
  }
  return {
    url: context.redactText(url).slice(0, 500),
    lineNumber: Number.isSafeInteger(location.lineNumber) ? location.lineNumber : null,
    columnNumber: Number.isSafeInteger(location.columnNumber) ? location.columnNumber : null,
  };
}

function observeGatewayTransport(page, evidence) {
  page.on("request", request => {
    try {
      const url = new URL(request.url());
      if (url.pathname === "/api/mobile/session") evidence.sessionExchangeOrigins.add(url.origin);
    } catch { /* Non-URL browser requests are irrelevant to connection identity. */ }
  });
  page.on("websocket", socket => {
    try {
      const url = new URL(socket.url());
      if (url.pathname !== "/rpc") return;
      const protocol = url.protocol === "wss:" ? "https:" : "http:";
      evidence.rpcOrigins.add(`${protocol}//${url.host}`);
      evidence.rpcConnectionCount += 1;
      socket.on("framesent", frame => {
        try {
          const payload = frame && typeof frame === "object" && "payload" in frame
            ? frame.payload
            : frame;
          const serialized = typeof payload === "string"
            ? payload
            : Buffer.isBuffer(payload)
              ? payload.toString("utf8")
              : "";
          const json = JSON.parse(serialized);
          const requests = Array.isArray(json) ? json : [json];
          evidence.rpcInitializeRequestCount += requests.filter(request => request?.method === "initialize").length;
        } catch { /* Non-JSON WebSocket frames do not count as JSON-RPC initialization. */ }
      });
    } catch { /* Browser-internal WebSockets are not Gateway RPC evidence. */ }
  });
  page.on("response", response => {
    try {
      const url = new URL(response.url());
      const endpoint = url.pathname;
      const isSessionBootstrap = endpoint === "/api/mobile/session";
      if (!isSessionBootstrap && endpoint !== "/api/servers") return;
      const catalog = {
        origin: url.origin,
        status: response.status(),
        endpoint,
        source: endpoint,
        serverIds: [],
        parsed: false,
      };
      evidence.serverCatalogResponses.push(catalog);
      const task = response.json().then(payload => {
        let servers;
        if (isSessionBootstrap) {
          const bootstrapServers = response.ok() && payload?.capabilities?.mobileInitialServersV1 === true
            ? validInitialMobileServers(payload?.initialServers)
            : null;
          catalog.bootstrapAccepted = bootstrapServers !== null;
          servers = bootstrapServers ?? [];
        } else {
          servers = Array.isArray(payload?.servers) ? payload.servers : [];
        }
        catalog.serverIds = servers
          .map(server => server?.id)
          .filter(serverId => typeof serverId === "string");
      }).catch(() => {}).finally(() => { catalog.parsed = true; });
      evidence.serverCatalogResponseTasks.push(task);
    } catch { /* Non-JSON browser responses are not server-catalog evidence. */ }
  });
}

function validInitialMobileServers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).some(key => key !== "version" && key !== "servers") ||
      !Array.isArray(value.servers) || value.servers.length > 32) return null;
  const validServer = value.servers.every(server => server && typeof server === "object" && !Array.isArray(server) &&
    typeof server.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(server.id) &&
    typeof server.label === "string" && server.label.length <= 4096 &&
    typeof server.description === "string" && server.description.length <= 4096 &&
    server.runtime === "kcoder" && (server.transport === "local" || server.transport === "ssh"));
  if (!validServer) return null;
  const ids = value.servers.map(server => server.id);
  if (new Set(ids).size !== ids.length) return null;
  return value.servers;
}

async function openSettingsDetail(page, entryId, screenId, titleId, route) {
  await visibleTestId(page, entryId).click();
  await visibleTestId(page, screenId).waitFor({ state: "visible", timeout: 10_000 });
  await visibleTestId(page, titleId).waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(new URL(page.url()).pathname, route, `${entryId} must navigate to ${route}`);
}

async function recordDependencyPinProvenance(context, mobileWeb) {
  const dependencyRoot = mobileWeb.dependencyRoot;
  if (!process.env.KCODER_E2E_MOBILE_DEPENDENCY_ROOT) return;
  await access(dependencyRoot, constants.W_OK);
  const rootInfo = await stat(dependencyRoot);
  const privateRoot = dirname(dependencyRoot);
  const privateRootInfo = await stat(privateRoot);
  const sourceLockfile = "apps/kcoder-studio/mobile/package-lock.json";
  const lockfileBytes = await readFile(resolve(repoRoot, sourceLockfile));
  const keyPackages = ["expo", "expo-router", "react", "react-native"];
  const packageVersions = {};
  for (const packageName of keyPackages) {
    const packageJson = JSON.parse(await readFile(resolve(dependencyRoot, packageName, "package.json"), "utf8"));
    packageVersions[packageName] = packageJson.version;
  }
  const ownerWritable = (rootInfo.mode & 0o200) !== 0;
  assert.equal(ownerWritable, true, "the private dependency pin must remain owner-writable for RunContext cleanup");
  if (typeof process.getuid === "function") {
    assert.equal(rootInfo.uid, process.getuid(), "the private dependency pin must be owned by the E2E process user");
    assert.equal(privateRootInfo.uid, process.getuid(), "the private dependency pin parent must be owned by the E2E process user");
  }
  assert.equal(privateRootInfo.mode & 0o777, 0o700, "the private dependency pin parent must be mode 0700");
  await context.writeArtifactJson("mobile-dependency-pin-provenance.json", {
    dependencyRoot,
    privateRoot,
    pinCreatedAtUtc: process.env.KCODER_E2E_MOBILE_DEPENDENCY_PIN_CREATED_AT || null,
    sourceLockfile,
    sourceLockfileSha256: createHash("sha256").update(lockfileBytes).digest("hex"),
    packageVersions,
    dependencyTreeSha256: mobileWeb.dependencySourceTreeSha256,
    copiedDependencyTreeSha256: mobileWeb.dependencyOwnedTreeSha256,
    sourceTreeSha256: mobileWeb.sourceTreeSha256,
    ownerWritable,
    ownedByCurrentUser: typeof process.getuid === "function" ? rootInfo.uid === process.getuid() : null,
    privateRootMode: (privateRootInfo.mode & 0o777).toString(8).padStart(4, "0"),
    privateRootOwnedByCurrentUser: typeof process.getuid === "function" ? privateRootInfo.uid === process.getuid() : null,
    credentialsIncluded: false,
  });
}

async function returnToSettingsHome(page) {
  await visibleTestId(page, "settings-detail-back").click();
  await visibleTestId(page, "settings-home").waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(new URL(page.url()).pathname, "/settings", "a Settings detail Back action must return to Settings home");
}

function choiceOptionId(kind, preference) {
  const normalized = preference === "zh-CN" ? "zh-cn" : preference;
  return `settings-${kind}-choice-${normalized}`;
}

async function openChoiceSheet(page, kind) {
  await visibleTestId(page, `settings-${kind}-row`).click();
  const sheet = visibleTestId(page, `settings-choice-sheet-${kind}`);
  await sheet.waitFor({ state: "visible", timeout: 10_000 });
  return sheet;
}

async function cancelChoiceSheet(page, sheet) {
  await visibleTestId(page, "settings-choice-cancel").click();
  await sheet.waitFor({ state: "hidden", timeout: 10_000 });
}

async function appearanceChoiceState(page, kind, preference) {
  const sheet = await openChoiceSheet(page, kind);
  const option = visibleTestId(page, choiceOptionId(kind, preference));
  await option.waitFor({ state: "visible", timeout: 10_000 });
  const state = {
    role: await option.getAttribute("role"),
    ariaChecked: await option.getAttribute("aria-checked"),
    ariaDisabled: await option.getAttribute("aria-disabled"),
    disabled: await option.isDisabled(),
  };
  await cancelChoiceSheet(page, sheet);
  return state;
}

async function assertChoiceFocusReturned(page, kind, action) {
  const row = visibleTestId(page, `settings-${kind}-row`);
  assert.equal(
    await row.evaluate(element => element === document.activeElement || element.contains(document.activeElement)),
    true,
    `${kind} choice sheet ${action} must return focus to its opening row`,
  );
}

async function assertChoiceDismissalBehavior(page, kind, untouchedPreference) {
  const before = await readPreferences(page);
  const row = visibleTestId(page, `settings-${kind}-row`);
  const summaryBefore = await row.innerText();

  const cancelledSheet = await openChoiceSheet(page, kind);
  await visibleTestId(page, "settings-choice-cancel").waitFor({ state: "visible", timeout: 10_000 });
  await visibleTestId(page, choiceOptionId(kind, untouchedPreference)).waitFor({ state: "visible", timeout: 10_000 });
  await visibleTestId(page, "settings-choice-cancel").click();
  await cancelledSheet.waitFor({ state: "hidden", timeout: 10_000 });
  assert.deepEqual(await readPreferences(page), before, `${kind} Cancel must not change stored preferences`);
  assert.equal(await row.innerText(), summaryBefore, `${kind} Cancel must leave the visible summary unchanged`);
  await assertChoiceFocusReturned(page, kind, "Cancel");

  const escapedSheet = await openChoiceSheet(page, kind);
  await visibleTestId(page, choiceOptionId(kind, untouchedPreference)).waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.press("Escape");
  await escapedSheet.waitFor({ state: "hidden", timeout: 10_000 });
  assert.deepEqual(await readPreferences(page), before, `${kind} Escape must not change stored preferences`);
  assert.equal(await row.innerText(), summaryBefore, `${kind} Escape must leave the visible summary unchanged`);
  await assertChoiceFocusReturned(page, kind, "Escape");
}

async function selectLanguage(page, preference, expectedLocale) {
  const storedPreference = await readPreferences(page);
  const row = visibleTestId(page, "settings-language-row");
  const summaryBefore = await row.innerText();
  const sheet = await openChoiceSheet(page, "language");
  const option = visibleTestId(page, choiceOptionId("language", preference));
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await option.click();
  await sheet.waitFor({ state: "hidden", timeout: 10_000 });
  await assertChoiceFocusReturned(page, "language", "selection");
  await page.waitForFunction(expected => document.documentElement.lang === expected, expectedLocale, { timeout: 10_000 });
  await waitForPreference(page, { language: preference });
  if (storedPreference?.language !== preference) {
    assert.notEqual(await row.innerText(), summaryBefore, "selecting a language must update the visible row summary");
  }
  const state = await appearanceChoiceState(page, "language", preference);
  assert.equal(state.ariaChecked, "true", `${preference} language choice must expose its selected state`);
  await waitForAppearanceHeading(page);
}

async function selectTheme(page, preference) {
  const storedPreference = await readPreferences(page);
  const row = visibleTestId(page, "settings-theme-row");
  const summaryBefore = await row.innerText();
  const sheet = await openChoiceSheet(page, "theme");
  const option = visibleTestId(page, choiceOptionId("theme", preference));
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await option.click();
  await sheet.waitFor({ state: "hidden", timeout: 10_000 });
  await assertChoiceFocusReturned(page, "theme", "selection");
  await waitForPreference(page, { theme: preference });
  if (storedPreference?.theme !== preference) {
    assert.notEqual(await row.innerText(), summaryBefore, "selecting a theme must update the visible row summary");
  }
  const state = await appearanceChoiceState(page, "theme", preference);
  assert.equal(state.ariaChecked, "true", `${preference} theme choice must expose its selected state`);
  await waitForAppearanceHeading(page);
}

async function waitForAppearanceHeading(page) {
  await visibleTestId(page, "settings-appearance-title").waitFor({ state: "visible", timeout: 10_000 });
}

async function assertFitsCompactViewport(control, testId) {
  await control.scrollIntoViewIfNeeded();
  await control.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await control.isEnabled(), true, `${testId} must remain operable at 320px`);
  const bounds = await control.boundingBox();
  assert.ok(bounds, `${testId} must have a visible layout box at 320px`);
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320,
    `${testId} must fit within the 320px viewport without horizontal overflow`);
  assert.ok(bounds.height >= 44, `${testId} must retain a 44px touch target at 320px`);
}

async function assertNoCompactHorizontalOverflow(page, label) {
  const width = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.equal(width.viewport, 320);
  assert.ok(Math.max(width.document, width.body) <= width.viewport,
    `${label} must not introduce horizontal scrolling at 320px`);
}

async function verifyCompactAppearanceControls(page, context) {
  await page.setViewportSize({ width: 320, height: 568 });
  await returnToSettingsHome(page);
  await page.screenshot({ path: context.pathInArtifacts("settings-home-320-dark.png"), animations: "disabled" });
  await assertNoCompactHorizontalOverflow(page, "Settings home");
  for (const testId of [
    "settings-manage-connections",
    "settings-appearance",
    "terminal-settings",
    "diagnostics-settings",
    "settings-about",
  ]) {
    await assertFitsCompactViewport(visibleTestId(page, testId), testId);
  }

  await openSettingsDetail(page, "settings-appearance", "settings-appearance-screen", "settings-appearance-title", "/settings-appearance");
  await page.screenshot({ path: context.pathInArtifacts("settings-appearance-320.png"), animations: "disabled" });
  await assertNoCompactHorizontalOverflow(page, "Appearance settings");
  await assertFitsCompactViewport(visibleTestId(page, "settings-theme-row"), "settings-theme-row");
  await assertFitsCompactViewport(visibleTestId(page, "settings-language-row"), "settings-language-row");

  for (const [kind, choices] of [
    ["theme", ["system", "light", "dark"]],
    ["language", ["system", "en", "zh-CN"]],
  ]) {
    const sheet = await openChoiceSheet(page, kind);
    await page.screenshot({ path: context.pathInArtifacts(`settings-${kind}-choice-320.png`), animations: "disabled" });
    await assertNoCompactHorizontalOverflow(page, `${kind} choice sheet`);
    for (const choice of choices) {
      const testId = choiceOptionId(kind, choice);
      await assertFitsCompactViewport(visibleTestId(page, testId), testId);
    }
    await cancelChoiceSheet(page, sheet);
  }

  await selectTheme(page, "light");
  await waitForResolvedTheme(page, "light");
  await page.screenshot({ path: context.pathInArtifacts("settings-appearance-light-320.png"), animations: "disabled" });
  await returnToSettingsHome(page);
  await page.screenshot({ path: context.pathInArtifacts("settings-home-320-light.png"), animations: "disabled" });
  await openSettingsDetail(page, "settings-appearance", "settings-appearance-screen", "settings-appearance-title", "/settings-appearance");
  await selectTheme(page, "dark");
  await waitForResolvedTheme(page, "dark");
  await page.screenshot({ path: context.pathInArtifacts("settings-appearance-dark-320.png"), animations: "disabled" });
  await selectTheme(page, "system");
  await waitForResolvedTheme(page, "dark");
  await selectLanguage(page, "en", "en");
  await selectLanguage(page, "system", "zh-CN");
  await page.setViewportSize({ width: 390, height: 844 });
}

async function assertMainSettingsPlaceholdersHidden(page) {
  const english = await page.locator("html").getAttribute("lang") === "en";
  const placeholders = english
    ? [
      "Notifications",
      "Waiting for system push channel",
      "Voice & dictation",
      "Waiting for app-server voice stream protocol",
      "Schedules",
      "Waiting for app-server scheduling API",
    ]
    : [
      "通知",
      "等待系统推送通道",
      "语音与听写",
      "等待 app-server 语音流协议",
      "计划任务",
      "等待 app-server 调度 API",
    ];
  for (const placeholder of placeholders) {
    assert.equal(await visibleText(page, placeholder, { exact: true }).count(), 0,
      `Settings should not show the unfinished placeholder: ${placeholder}`);
  }
}

async function assertConnectionManagementProfileStates(page, context, inactiveProfileId, activeProfileId) {
  assert.equal(await visibleTestId(page, `remove-profile-${inactiveProfileId}`).count(), 0,
    "the main Settings page must not expose direct profile deletion");
  assert.equal(await visibleTestId(page, `remove-profile-${activeProfileId}`).count(), 0,
    "the main Settings page must not expose direct deletion for the active profile");
  await openSettingsDetail(page, "settings-manage-connections", "settings-connections-screen", "settings-connections-title", "/settings-connections");
  const inactiveRow = visibleTestId(page, `settings-gateway-${inactiveProfileId}`);
  const activeRow = visibleTestId(page, `settings-gateway-${activeProfileId}`);
  await inactiveRow.waitFor({ state: "visible", timeout: 10_000 });
  await activeRow.waitFor({ state: "visible", timeout: 10_000 });
  const english = await page.locator("html").getAttribute("lang") === "en";
  await inactiveRow.getByText(english ? "Not checked" : "未检测", { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await visibleTestId(page, `remove-profile-${inactiveProfileId}`).count(), 1,
    "the inactive Gateway profile detail must expose its own removal action");
  const activeRemoval = visibleTestId(page, `remove-profile-${activeProfileId}`);
  assert.equal(await activeRemoval.count(), 1,
    "the active Gateway profile remains removable from connection management details");
  const confirmationPromise = page.waitForEvent("dialog");
  const removalClickPromise = activeRemoval.click();
  const confirmation = await confirmationPromise;
  assert.equal(confirmation.type(), "confirm", "profile removal must require a native confirmation");
  assert.match(confirmation.message(), english ? /Remove Gateway\?/ : /移除 Gateway[？?]/);
  await confirmation.dismiss();
  await removalClickPromise;
  await page.setViewportSize({ width: 320, height: 568 });
  await page.screenshot({ path: context.pathInArtifacts("settings-connections-profiles-320.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: context.pathInArtifacts("settings-connections-profiles-390.png"), animations: "disabled" });
  await returnToSettingsHome(page);
  await visibleTestId(page, "settings-manage-connections").waitFor({ state: "visible", timeout: 10_000 });
}

async function assertThemeSelection(page, preference) {
  for (const candidate of ["light", "dark", "system"]) {
    const state = await appearanceChoiceState(page, "theme", candidate);
    assert.equal(state.ariaChecked, String(candidate === preference),
      `${candidate} theme choice must expose its selected state`);
  }
}

function visibleTestId(page, testId) {
  return page.getByTestId(testId).and(page.locator(":visible"));
}

function visibleText(page, text, options) {
  return page.getByText(text, options).and(page.locator(":visible"));
}

async function assertResolvedTheme(page, mode) {
  const theme = await page.evaluate(() => ({
    colorScheme: document.documentElement.style.colorScheme,
    mobileColorScheme: getComputedStyle(document.documentElement).getPropertyValue("--mobile-color-scheme").trim(),
    backgroundColor: getComputedStyle(document.documentElement).backgroundColor,
  }));
  assert.equal(theme.colorScheme, mode, "the live document color-scheme must match the resolved Mobile theme");
  assert.equal(theme.mobileColorScheme, mode);
  const normalizedBackground = theme.backgroundColor.replaceAll(" ", "");
  assert.equal(normalizedBackground, mode === "light" ? "rgb(255,255,255)" : "rgb(24,24,27)");
}

async function waitForResolvedTheme(page, mode) {
  await page.waitForFunction(expected => document.documentElement.style.colorScheme === expected, mode, { timeout: 10_000 });
  await assertResolvedTheme(page, mode);
}

async function waitForPreference(page, expected) {
  await page.waitForFunction(({ key, expected: wanted }) => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "null");
      return Object.entries(wanted).every(([field, value]) => stored?.[field] === value);
    } catch {
      return false;
    }
  }, { key: preferenceKey, expected }, { timeout: 10_000 });
}

async function readPreferences(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), preferenceKey);
}

async function assertPreferenceSelection(page, expected) {
  await openSettingsDetail(page, "settings-appearance", "settings-appearance-screen", "settings-appearance-title", "/settings-appearance");
  const language = await appearanceChoiceState(page, "language", expected.language);
  const theme = await appearanceChoiceState(page, "theme", expected.theme);
  assert.equal(language.ariaChecked, "true");
  assert.equal(theme.ariaChecked, "true");
  await returnToSettingsHome(page);
}

async function waitForDraftPersistence(page, draft) {
  await page.waitForFunction(value => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key !== "kcoder-studio:mobile-app-preferences:v1"
        && localStorage.getItem(key)?.includes(value)) return true;
    }
    return false;
  }, draft, { timeout: 10_000 });
}

async function selectScrollback(page, lines) {
  const settings = terminalSettings(page);
  assert.equal(await settings.count(), 1, "active Settings route must expose one visible Terminal preference row");
  await openSettingsDetail(page, "terminal-settings", "settings-terminal-screen", "settings-terminal-title", "/settings-terminal");
  const option = visibleTestId(page, `terminal-scrollback-${lines}`);
  await option.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await option.getAttribute("role"), "radio", `terminal-scrollback-${lines} must be an accessible radio option`);
  await option.click();
  await waitForPreference(page, { terminalScrollbackLines: lines });
  const state = {
    role: await option.getAttribute("role"),
    ariaChecked: await option.getAttribute("aria-checked"),
    ariaSelected: await option.getAttribute("aria-selected"),
  };
  await returnToSettingsHome(page);
  return state;
}

async function openSettings(page) {
  const direct = page.locator('[aria-label="设置"]:visible, [aria-label="Settings"]:visible');
  const directCount = await direct.count();
  if (directCount === 1) {
    await direct.click();
  } else {
    assert.equal(directCount, 0, "direct Settings control must be absent or unique on the active route");
    const menu = page.locator(
      '[aria-label="打开任务列表"]:visible, [aria-label="Open task list"]:visible, [aria-label="打开导航"]:visible, [aria-label="Open navigation"]:visible',
    );
    assert.equal(await menu.count(), 1, "active task route must expose one visible navigation control");
    await menu.click();
    const drawerSettings = page.locator('[aria-label="设置"]:visible, [aria-label="Settings"]:visible');
    assert.equal(await drawerSettings.count(), 1, "active drawer must expose one visible Settings control");
    await drawerSettings.click();
  }
  await visibleTestId(page, "settings-home").waitFor({ state: "visible", timeout: 30_000 });
}

async function closeSettings(page) {
  const back = visibleTestId(page, "settings-detail-back");
  assert.equal(await back.count(), 1, "Settings home must expose one visible Back action");
  await back.click();
  await visibleTestId(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
}

function terminalSettings(page) {
  return page.locator('[data-testid="terminal-settings"]:visible');
}

async function connectPhysicalOrigin(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    visibleTestId(page, "welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await visibleTestId(page, "welcome-direct-connection").click();
  await visibleTestId(page, "gateway-token").fill(gateway.authToken);
  await visibleTestId(page, "gateway-connect").click();
  await visibleTestId(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, prompt, context, expectedProfileId, expectedGatewayBaseUrl, transport, stage) {
  try {
    await visibleTestId(page, "new-workspace").click();
    await page.waitForURL(url => url.pathname === "/new", { timeout: 10_000 });
    const routedProfileId = new URL(page.url()).searchParams.get("profileId");
    assert.equal(routedProfileId, expectedProfileId,
      `new-workspace route must explicitly target profile ${expectedProfileId}`);

    const expectedOrigin = new URL(expectedGatewayBaseUrl).origin;
    const catalog = await waitFor(() => transport.serverCatalogResponses.find(response =>
      response.origin === expectedOrigin && response.status === 200 && response.parsed && response.serverIds.includes("local")),
    15_000, `${stage} Gateway catalog includes local`, 50, context.abortSignal);
    assert.ok(catalog, `${stage} Gateway must return a server catalog containing local`);

    const localOption = visibleTestId(page, "server-option-local");
    const localOptionCount = await localOption.count();
    assert.ok(localOptionCount <= 1, `${stage} must expose at most one visible local server option`);
    if (localOptionCount === 1) await localOption.click();

    await visibleTestId(page, "workspace-path").waitFor({ state: "visible", timeout: 30_000 });
    await visibleTestId(page, "new-workspace-prompt").fill(prompt);
    const create = visibleTestId(page, "create-workspace");
    await create.waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(() => create.isEnabled(), 30_000, `${stage} create action enabled`, 100, context.abortSignal);
    await create.click();
    await visibleTestId(page, "message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 60_000 });
    await visibleTestId(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(() => location.pathname.includes("/task/"), null, { timeout: 30_000 });
    const task = taskIdentityFromUrl(page.url());
    assert.equal(task.profileId, expectedProfileId, `${stage} task must remain on its selected Gateway profile`);
    assert.equal(task.serverId, "local", `${stage} task route must prove the actual target server is local`);
    return task;
  } catch (error) {
    await writeTaskSetupDiagnostic(page, context, transport, stage, expectedGatewayBaseUrl).catch(() => {});
    throw error;
  }
}

async function writeTaskSetupDiagnostic(page, context, transport, stage, expectedGatewayBaseUrl) {
  const pageState = await page.evaluate(() => {
    const current = new URL(location.href);
    const query = Object.fromEntries([...current.searchParams.entries()].map(([key, value]) => [
      key,
      /token|secret|credential|authorization|password|api.?key/i.test(key) ? "[REDACTED]" : value,
    ]));
    const controls = [
      "new-workspace", "server-option-local", "workspace-path", "new-workspace-prompt",
      "create-workspace", "new-workspace-error", "retry-new-workspace-catalogs",
    ].map(testId => {
      const visible = [...document.querySelectorAll(`[data-testid="${testId}"]`)].filter(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      return {
        testId,
        count: visible.length,
        controls: visible.map(element => ({
          text: (element.innerText || element.textContent || "").slice(0, 400),
          disabled: Boolean(element.disabled),
          ariaDisabled: element.getAttribute("aria-disabled"),
          selected: element.getAttribute("aria-selected") ?? element.getAttribute("aria-pressed"),
        })),
      };
    });
    let profileStore = null;
    try {
      const stored = JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") ?? "null");
      profileStore = {
        activeId: typeof stored?.activeId === "string" ? stored.activeId : null,
        profileIds: Array.isArray(stored?.profiles)
          ? stored.profiles.map(profile => profile?.id).filter(value => typeof value === "string")
          : [],
      };
    } catch {
      profileStore = { parseFailed: true };
    }
    return {
      route: { pathname: current.pathname, query, hashPresent: Boolean(current.hash) },
      documentLanguage: document.documentElement.lang,
      profileStore,
      visibleBodyText: (document.body?.innerText ?? "").slice(0, 8_000),
      controls,
    };
  });
  const sanitizedPageUrl = sanitizeBrowserUrl(page.url());
  const visibleBodyText = redactPossiblePairingUrls(context.redactText(pageState.visibleBodyText));
  await context.writeArtifactJson(`mobile-appearance-task-setup-${stage}-diagnostic.json`, {
    stage,
    url: sanitizedPageUrl,
    expectedGatewayOrigin: new URL(expectedGatewayBaseUrl).origin,
    page: { ...pageState, visibleBodyText },
    serverCatalogResponses: transport.serverCatalogResponses,
  });
  await page.screenshot({
    path: context.pathInArtifacts(`mobile-appearance-task-setup-${stage}-failure.png`),
    animations: "disabled",
  });
}

function sanitizeBrowserUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|credential|authorization|password|api.?key/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    if (url.hash) url.hash = "[REDACTED]";
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

function redactPossiblePairingUrls(value) {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, candidate => {
    try {
      const url = new URL(candidate);
      for (const key of [...url.searchParams.keys()]) {
        if (/token|secret|credential|authorization|password|api.?key|pair|code/i.test(key)) {
          url.searchParams.set(key, "[REDACTED]");
        }
      }
      if (url.hash) url.hash = "[REDACTED]";
      return url.toString();
    } catch {
      return "[REDACTED-URL]";
    }
  });
}

async function openTaskFromHome(page, task) {
  assert.equal(profileFromUrl(page.url()), task.profileId);
  const item = visibleTestId(page, `thread-${task.threadId}`);
  await item.waitFor({ state: "visible", timeout: 30_000 });
  await item.click();
  await visibleTestId(page, "message-input-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(expected => location.pathname.includes(encodeURIComponent(expected)), task.threadId, { timeout: 30_000 });
  assert.deepEqual(taskIdentityFromUrl(page.url()), task);
}

async function switchProfile(page, targetProfileId) {
  await visibleTestId(page, "settings-manage-connections").click();
  const profiles = await readProfiles(page);
  const target = profiles.find(profile => profile.id === targetProfileId);
  assert.ok(target, `target Gateway profile ${targetProfileId} must remain in the profile list`);
  const action = visibleTestId(page, `settings-gateway-${targetProfileId}`);
  await action.waitFor({ state: "visible", timeout: 10_000 });
  await action.click();
  await visibleTestId(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(expected => decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] ?? "") === expected,
    targetProfileId, { timeout: 30_000 });
}

async function waitForOrigin(origins, baseUrl, label, context) {
  const expected = new URL(baseUrl).origin;
  await waitFor(() => origins.has(expected) ? expected : null, 15_000, label, 50, context.abortSignal);
}

function profileFromUrl(url) {
  const profileId = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean)[1] ?? "");
  assert.ok(profileId, `URL 缺少 profileId: ${url}`);
  return profileId;
}

function taskIdentityFromUrl(url) {
  const segments = new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const taskIndex = segments.indexOf("task");
  assert.ok(taskIndex >= 0 && segments[taskIndex + 1] && segments[taskIndex + 2], `URL 缺少任务身份: ${url}`);
  return {
    profileId: profileFromUrl(url),
    serverId: segments[taskIndex + 1],
    threadId: segments[taskIndex + 2],
  };
}

async function readProfiles(page) {
  return page.evaluate(() => {
    try {
      const profiles = JSON.parse(localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2") ?? "null")?.profiles;
      return Array.isArray(profiles) ? profiles.map(profile => ({
        id: typeof profile?.id === "string" ? profile.id : null,
        label: typeof profile?.label === "string" ? profile.label : null,
        baseUrl: typeof profile?.baseUrl === "string" ? profile.baseUrl : null,
      })) : [];
    } catch {
      return [];
    }
  });
}
