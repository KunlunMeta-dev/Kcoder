import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
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
  });
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
  const chromium = await startChromium(context, { label: "mobile-app-preferences-chromium" });
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
  observe(page, diagnostics);
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

  await openSettings(page);
  const settingsRpcBaseline = {
    websocketConnections: transport.rpcConnectionCount,
    initializeRequests: transport.rpcInitializeRequestCount,
  };
  assert.ok(settingsRpcBaseline.websocketConnections > 0,
    "the active task must have an observed real Gateway app-server WebSocket before changing preferences");
  assert.ok(settingsRpcBaseline.initializeRequests > 0,
    "the active task must have sent an observed app-server initialize request before changing preferences");
  assert.match(await terminalSettings(page).innerText(), /10,000 行回滚/,
    "a new browser profile starts with the default terminal scrollback preference");
  const hiddenExecutionSettings = {
    plugins: await visibleText(page, "插件", { exact: true }).count(),
    defaultModel: await visibleText(page, "默认模型", { exact: true }).count(),
  };
  assert.deepEqual(hiddenExecutionSettings, { plugins: 0, defaultModel: 0 },
    "Mobile 设置不应暴露无法由 app-server 持久化的插件或默认模型入口");

  const initialLanguage = await appearanceButtonState(page, "settings-language-system");
  const initialTheme = {
    light: await appearanceButtonState(page, "settings-theme-light"),
    dark: await appearanceButtonState(page, "settings-theme-dark"),
    system: await appearanceButtonState(page, "settings-theme-system"),
  };
  assert.equal(initialLanguage.ariaPressed, "true", "system language must be selected by default");
  assert.equal(initialTheme.system.ariaPressed, "true", "system theme must be selected by default");
  for (const state of [initialTheme.light, initialTheme.dark, initialTheme.system]) {
    assert.notEqual(state.ariaDisabled, "true", "all three theme choices must be operable");
    assert.equal(state.disabled, false);
  }

  await selectLanguage(page, "en", "en");
  await selectLanguage(page, "zh-CN", "zh-CN");
  await selectLanguage(page, "system", "zh-CN");
  await selectLanguage(page, "en", "en");

  await visibleAppearanceControl(page, "settings-theme-light").click();
  await waitForResolvedTheme(page, "light");
  await assertThemeSelection(page, "light");
  await page.screenshot({ path: context.pathInArtifacts("mobile-appearance-light.png"), animations: "disabled" });

  await visibleAppearanceControl(page, "settings-theme-dark").click();
  await waitForResolvedTheme(page, "dark");
  await assertThemeSelection(page, "dark");
  await page.screenshot({ path: context.pathInArtifacts("mobile-appearance-dark.png"), animations: "disabled" });

  await visibleAppearanceControl(page, "settings-theme-system").click();
  await waitForResolvedTheme(page, "dark");
  await assertThemeSelection(page, "system");
  await page.emulateMedia({ colorScheme: "light" });
  await waitForResolvedTheme(page, "light");
  await assertThemeSelection(page, "system");
  await page.emulateMedia({ colorScheme: "dark" });
  await waitForResolvedTheme(page, "dark");

  const selected50kState = await selectScrollback(page, "50,000");
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
    reason: "Retain two small 390x844 Chromium screenshots so reviewers can inspect the real Expo Web light and dark palettes.",
    evidence: ["mobile-appearance-light.png", "mobile-appearance-dark.png"],
    runtime: "Expo Web export served by this run's isolated Gateway in Chromium",
    nativeHermesOrPhysicalDevice: false,
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
  await visibleText(page, "Appearance", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  const addGatewayLabel = await page.locator("html").getAttribute("lang") === "en" ? "Add Gateway" : "添加 Gateway";
  const addGateway = visibleText(page, addGatewayLabel, { exact: true });
  assert.equal(await addGateway.count(), 1, "Settings must expose one Add Gateway action");
  await addGateway.click();
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
    response.origin === new URL(gatewayB.baseUrl).origin && response.serverIds.includes("local")),
  10_000, "profile B Gateway server catalog includes local", 50, context.abortSignal);

  await openSettings(page);
  await assertPreferenceSelection(page, { language: "en", theme: "system" });
  assert.match(await terminalSettings(page).innerText(), /50,000 lines scrollback/,
    "app preferences are shared across Gateway profiles on the same mobile browser");
  await selectScrollback(page, "100,000");
  await waitForPreference(page, { language: "en", theme: "system", terminalScrollbackLines: 100_000 });
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
  observe(isolatedPage, isolatedDiagnostics);
  await connectPhysicalOrigin(isolatedPage, gatewayA);
  await openSettings(isolatedPage);
  await assertPreferenceSelection(isolatedPage, { language: "system", theme: "system" });
  await assertResolvedTheme(isolatedPage, "light");
  assert.match(await terminalSettings(isolatedPage).innerText(), /10,000 行回滚/,
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
  observe(corruptedPage, corruptedDiagnostics);
  await connectPhysicalOrigin(corruptedPage, gatewayA);
  await openSettings(corruptedPage);
  await assertPreferenceSelection(corruptedPage, { language: "system", theme: "system" });
  await assertResolvedTheme(corruptedPage, "light");
  assert.match(await terminalSettings(corruptedPage).innerText(), /10,000 行回滚/,
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
  observe(clampedPage, clampedDiagnostics);
  await connectPhysicalOrigin(clampedPage, gatewayA);
  await openSettings(clampedPage);
  await assertPreferenceSelection(clampedPage, { language: "system", theme: "system" });
  await assertResolvedTheme(clampedPage, "light");
  assert.match(await terminalSettings(clampedPage).innerText(), /100,000 行回滚/,
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

function observe(page, output) {
  page.on("pageerror", error => output.push(`pageerror:${error.name || "Error"}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) output.push(message.type());
  });
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
      if (url.pathname !== "/api/servers") return;
      const catalog = {
        origin: url.origin,
        status: response.status(),
        serverIds: [],
        parsed: false,
      };
      evidence.serverCatalogResponses.push(catalog);
      const task = response.json().then(payload => {
        const servers = Array.isArray(payload?.servers) ? payload.servers : [];
        catalog.serverIds = servers
          .map(server => server?.id)
          .filter(serverId => typeof serverId === "string");
      }).catch(() => {}).finally(() => { catalog.parsed = true; });
      evidence.serverCatalogResponseTasks.push(task);
    } catch { /* Non-JSON browser responses are not server-catalog evidence. */ }
  });
}

async function appearanceButtonState(page, testId) {
  const button = visibleAppearanceControl(page, testId);
  assert.equal(await button.count(), 1, `expected one visible ${testId} appearance control`);
  return {
    ariaPressed: await button.getAttribute("aria-pressed"),
    ariaDisabled: await button.getAttribute("aria-disabled"),
    disabled: await button.isDisabled(),
  };
}

async function selectLanguage(page, preference, expectedLocale) {
  const button = visibleAppearanceControl(page, `settings-language-${preference === "zh-CN" ? "zh-cn" : preference}`);
  await button.click();
  await page.waitForFunction(expected => document.documentElement.lang === expected, expectedLocale, { timeout: 10_000 });
  const appearanceLabel = expectedLocale === "en" ? "Appearance" : "外观";
  await visibleText(page, appearanceLabel, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await button.getAttribute("aria-pressed"), "true");
}

async function assertThemeSelection(page, preference) {
  for (const candidate of ["light", "dark", "system"]) {
    const button = visibleAppearanceControl(page, `settings-theme-${candidate}`);
    assert.equal(await button.getAttribute("aria-pressed"), String(candidate === preference),
      `${candidate} theme control must expose its selected state`);
  }
}

function visibleAppearanceControl(page, testId) {
  return visibleTestId(page, testId);
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
  const language = await appearanceButtonState(page, `settings-language-${expected.language === "zh-CN" ? "zh-cn" : expected.language}`);
  const theme = await appearanceButtonState(page, `settings-theme-${expected.theme}`);
  assert.equal(language.ariaPressed, "true");
  assert.equal(theme.ariaPressed, "true");
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

async function selectScrollback(page, label) {
  const settings = terminalSettings(page);
  assert.equal(await settings.count(), 1, "active Settings route must expose one visible Terminal preference row");
  await settings.click();
  const english = await page.locator("html").getAttribute("lang") === "en";
  const dialogLabel = english ? "Terminal settings" : "终端设置";
  const closeLabel = english ? "Close" : "关闭";
  const dialog = page.locator(`[role="dialog"][aria-label="${dialogLabel}"]:visible`);
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await dialog.count(), 1, "active route must expose exactly one visible scrollback dialog");
  const option = dialog.getByRole("radio", { name: label, exact: true });
  assert.equal(await option.count(), 1, `scrollback dialog must expose one radio for ${label}`);
  await option.click();
  await page.waitForTimeout(100);
  const state = {
    label,
    role: await option.getAttribute("role"),
    ariaChecked: await option.getAttribute("aria-checked"),
    ariaSelected: await option.getAttribute("aria-selected"),
  };
  const close = dialog.getByLabel(closeLabel, { exact: true });
  assert.equal(await close.count(), 1, "active dialog must expose one visible Close action");
  await close.click();
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
  await terminalSettings(page).waitFor({ state: "visible", timeout: 30_000 });
}

async function closeSettings(page) {
  const back = page.locator('[aria-label="返回"]:visible, [aria-label="Back"]:visible');
  assert.equal(await back.count(), 1, "Settings must expose one visible Back action");
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
      response.origin === expectedOrigin && response.serverIds.includes("local")),
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
  const profiles = await readProfiles(page);
  const target = profiles.find(profile => profile.id === targetProfileId);
  assert.ok(target, `target Gateway profile ${targetProfileId} must remain in the profile list`);
  const english = await page.locator("html").getAttribute("lang") === "en";
  const label = english ? "Switch to" : "切换到";
  const action = page.getByLabel(`${label} ${target.label}`, { exact: true }).and(page.locator(":visible"));
  assert.equal(await action.count(), 1, "Settings must expose one action for the requested Gateway profile");
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
