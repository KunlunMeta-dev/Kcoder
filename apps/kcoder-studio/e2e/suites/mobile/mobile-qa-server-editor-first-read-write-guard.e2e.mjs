import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { reuseMobileWebExport } from "../../harness/mobile-web-export-reuse.mjs";
import { runE2E } from "../../harness/run-context.mjs";

const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
const COLLISION_SERVER_ID = "collision-ssh";
const INJECTED_READ_ERROR = "Injected first server-list read failure";
const REQUIRED_MOBILE_SOURCE_TREE_SHA256 =
  "22b16584df407b80b3a235a964042b6f04103f6ea52237ad90e02a75a182c5ca";

await runE2E(
  import.meta.url,
  {
    testId: "mobile-qa-server-editor-first-read-write-guard",
    tier: "model-independent",
    modelPolicy:
      "real Mobile Web and authenticated isolated mock Gateway; no provider/model request and no server mutation",
  },
  async (context) => {
    const frozenMobileSourceTreeSha256 = requiredSha256Pin(
      "KCODER_E2E_SERVER_EDITOR_SOURCE_TREE_SHA256",
    );
    assert.equal(
      frozenMobileSourceTreeSha256,
      REQUIRED_MOBILE_SOURCE_TREE_SHA256,
      "the retained Mobile export must match the frozen source snapshot",
    );
    const frozenMobileBundleSha256 = requiredSha256Pin(
      "KCODER_E2E_SERVER_EDITOR_BUNDLE_SHA256",
    );
    const frozenMobileBundleManifestSha256 = requiredSha256Pin(
      "KCODER_E2E_SERVER_EDITOR_MANIFEST_SHA256",
    );
    const frozenMobileBundleRoot = requiredAbsolutePath(
      "KCODER_E2E_SERVER_EDITOR_BUNDLE_ROOT",
    );
    const frozenMobileBundleManifest = requiredAbsolutePath(
      "KCODER_E2E_SERVER_EDITOR_MANIFEST_PATH",
    );
    const mobileWeb = await reuseMobileWebExport(context, {
      bundleRoot: frozenMobileBundleRoot,
      manifestPath: frozenMobileBundleManifest,
      expectedSourceTreeSha256: frozenMobileSourceTreeSha256,
      expectedManifestSha256: frozenMobileBundleManifestSha256,
      expectedBundleSha256: frozenMobileBundleSha256,
      label: "server-editor-first-read-guard-mobile-web",
      outputName: "mobile-web-export",
    });
    assert.equal(mobileWeb.sourceTreeSha256, frozenMobileSourceTreeSha256);
    assert.equal(mobileWeb.bundleSha256, frozenMobileBundleSha256);
    assert.equal(mobileWeb.expectedManifestSha256, frozenMobileBundleManifestSha256);
    assert.equal(mobileWeb.expectedBundleSha256, frozenMobileBundleSha256);
    assert.equal(mobileWeb.sourceManifestSha256, frozenMobileBundleManifestSha256);
    assert.equal(mobileWeb.bundleFileCount, 37);
    assert.equal(mobileWeb.exportPerformed, false, "the retained export reuse must not invoke Expo");
    const workspace = context.pathInState("workspace");
    await mkdir(workspace, { recursive: true });
    const serversStore = await context.writeStateJson("servers-store.json", [
      {
        id: COLLISION_SERVER_ID,
        label: "Preserved owned SSH target",
        runtime: "kcoder",
        transport: "ssh",
        host: "192.0.2.44",
        user: "fixture-user",
        port: 22,
        command: "kcoder",
        workspace: "/srv/preserved-target",
      },
    ]);
    const originalServersStore = await readFile(serversStore, "utf8");
    const gateway = await startGateway(context, {
      auth: true,
      label: "server-editor-first-read-guard-gateway",
      workspace,
      serversStore,
      env: {
        KCODER_STUDIO_MOCK: "1",
        KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
      },
    });
    const chromium = await startChromium(context, {
      label: "server-editor-first-read-guard-chromium",
    });
    const page = await chromium.browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 390, height: 844 });

    const serverListResponses = [];
    const serverWriteRequests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.origin === gateway.baseUrl &&
        /^\/api\/servers\/[^/]+$/.test(url.pathname) &&
        ["PUT", "DELETE"].includes(request.method())
      ) {
        serverWriteRequests.push({ method: request.method(), pathname: url.pathname });
      }
    });

    await connectInitialProfile(page, gateway);
    await page.locator('[aria-label="设置"]:visible').first().click();
    await page.getByTestId(`settings-host-${COLLISION_SERVER_ID}`).waitFor({
      state: "visible",
      timeout: 30_000,
    });
    const persistedProfile = await page.evaluate(
      ({ key, baseUrl }) => {
        const value = JSON.parse(localStorage.getItem(key) ?? "null");
        const profiles = Array.isArray(value) ? value : value?.profiles;
        return Array.isArray(profiles) && profiles.some((profile) => profile?.baseUrl === baseUrl);
      },
      { key: PROFILE_INDEX_KEY, baseUrl: gateway.baseUrl },
    );
    assert.equal(persistedProfile, true, "the Mobile Gateway profile must be persisted before reload");
    assert.deepEqual(JSON.parse(originalServersStore), [
      {
        id: COLLISION_SERVER_ID,
        label: "Preserved owned SSH target",
        runtime: "kcoder",
        transport: "ssh",
        host: "192.0.2.44",
        user: "fixture-user",
        port: 22,
        command: "kcoder",
        workspace: "/srv/preserved-target",
      },
    ]);

    let queuedServerListFailures = 1;
    const injectedServerListFailures = [];
    await page.route(
      (url) => {
        try {
          const parsed = new URL(url);
          return parsed.origin === gateway.baseUrl && parsed.pathname === "/api/servers";
        } catch {
          return false;
        }
      },
      async (route) => {
        const request = route.request();
        if (request.method() === "GET" && queuedServerListFailures > 0) {
          queuedServerListFailures -= 1;
          injectedServerListFailures.push({ method: "GET", status: 503 });
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: INJECTED_READ_ERROR }),
          });
          return;
        }
        await route.continue();
      },
    );

    const firstReloadReadFailure = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === gateway.baseUrl &&
          url.pathname === "/api/servers" &&
          response.request().method() === "GET" &&
          response.status() === 503
        );
      },
      { timeout: 15_000 },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    const firstReloadReadResponse = await firstReloadReadFailure;
    serverListResponses.push({
      method: firstReloadReadResponse.request().method(),
      status: firstReloadReadResponse.status(),
    });
    await page.getByTestId("diagnostics-settings").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    assert.equal(
      injectedServerListFailures.length,
      1,
      "reload must issue the injected first server-list read",
    );
    assert.deepEqual(
      serverListResponses[0],
      { method: "GET", status: 503 },
      "the first /api/servers read after reload must fail while the Gateway fixture remains intact",
    );

    const lang = await page.locator("html").getAttribute("lang");
    const labels = lang?.startsWith("en")
      ? {
          diagnosticsBad: "Gateway connection has issues",
          closeDiagnostics: "Close settings detail",
          addConnection: "Add connection",
        }
      : {
          diagnosticsBad: "Gateway 连接存在问题",
          closeDiagnostics: "关闭设置详情",
          addConnection: "添加连接",
        };

    await page.getByTestId("diagnostics-settings").click();
    await page.getByText(labels.diagnosticsBad, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await page.getByText(INJECTED_READ_ERROR, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await page.getByLabel(labels.closeDiagnostics, { exact: true }).click();

    await page.getByText(labels.addConnection, { exact: true }).click();
    await page.getByTestId("server-editor-route").waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const idField = page.getByTestId("server-id");
    const labelField = page.getByLabel("显示名称", { exact: true });
    const hostField = page.getByLabel("SSH 主机", { exact: true });
    const editorReadError = page.getByTestId("server-list-read-error");
    await editorReadError.waitFor({ state: "visible", timeout: 10_000 });
    await editorReadError.getByText(INJECTED_READ_ERROR, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const initialErrorFieldsEditable = {
      id: await idField.isEditable(),
      label: await labelField.isEditable(),
      host: await hostField.isEditable(),
    };
    const testDuringInitialReadError = page.getByRole("button", {
      name: "测试连接",
      exact: true,
    });
    const saveDuringReadError = page.getByRole("button", { name: "保存", exact: true });
    const saveEnabledDuringInitialReadError = await saveDuringReadError.isEnabled();
    assert.deepEqual(initialErrorFieldsEditable, {
      id: false,
      label: false,
      host: false,
    });
    assert.equal(await testDuringInitialReadError.isEnabled(), false);
    assert.equal(saveEnabledDuringInitialReadError, false);
    assert.equal(
      await page.getByRole("button", { name: "删除此服务器", exact: true }).count(),
      0,
      "a new draft must not expose destructive actions before the target list is loaded",
    );
    await captureMaskedScreenshot(
      context,
      page,
      "server-editor-first-read-write-guard-initial-error.png",
    );
    await context.writeArtifactJson("server-editor-first-read-write-guard-initial-error-state.json", {
      retentionReason: "Key successful UI evidence: initial server-list read failure is shown inline and every available form/write action is blocked.",
      injectedFirstListReadStatus: serverListResponses[0]?.status ?? null,
      displayedReadError: INJECTED_READ_ERROR,
      fieldsEditable: initialErrorFieldsEditable,
      testConnectionEnabled: await testDuringInitialReadError.isEnabled(),
      saveEnabled: saveEnabledDuringInitialReadError,
      deleteActionVisible: false,
      serverWriteRequests: [...serverWriteRequests],
      serversStoreUnchanged:
        (await readFile(serversStore, "utf8")) === originalServersStore,
    });

    const firstExplicitRetry = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === gateway.baseUrl &&
          url.pathname === "/api/servers" &&
          response.request().method() === "GET"
        );
      },
      { timeout: 15_000 },
    );
    await page.getByTestId("server-list-read-retry").click();
    const firstRetryResponse = await firstExplicitRetry;
    serverListResponses.push({
      method: firstRetryResponse.request().method(),
      status: firstRetryResponse.status(),
    });
    assert.equal(firstRetryResponse.status(), 200, "inline retry must reload the owned Gateway server list");
    await editorReadError.waitFor({ state: "detached", timeout: 15_000 });
    await page.waitForFunction(
      ({ selector, expected }) => document.querySelector(selector)?.value === expected,
      { selector: '[data-testid="server-id"]', expected: COLLISION_SERVER_ID },
      { timeout: 15_000 },
    );
    assert.equal(await idField.isEditable(), false);
    assert.equal(await labelField.isEditable(), true);
    assert.equal(await hostField.isEditable(), true);
    const testButton = page.getByRole("button", { name: "测试连接", exact: true });
    const saveButton = page.getByRole("button", { name: "保存", exact: true });
    const deleteButton = page.getByRole("button", { name: "删除此服务器", exact: true });
    assert.equal(await testButton.isEnabled(), true);
    assert.equal(await saveButton.isEnabled(), true);
    assert.equal(await deleteButton.isEnabled(), true);

    const dirtyLabel = "Draft label retained after Gateway read recovery";
    const dirtyHost = "192.0.2.45";
    await labelField.fill(dirtyLabel);
    await hostField.fill(dirtyHost);

    queuedServerListFailures = 1;
    const existingDraftReadFailure = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === gateway.baseUrl &&
          url.pathname === "/api/servers" &&
          response.request().method() === "GET" &&
          response.status() === 503
        );
      },
      { timeout: 15_000 },
    );
    await triggerMobileAppActiveRefresh(page);
    const secondFailureResponse = await existingDraftReadFailure;
    serverListResponses.push({
      method: secondFailureResponse.request().method(),
      status: secondFailureResponse.status(),
    });
    assert.equal(secondFailureResponse.status(), 503);
    await editorReadError.waitFor({ state: "visible", timeout: 15_000 });
    await editorReadError.getByText(INJECTED_READ_ERROR, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const fieldsEditableDuringExistingDraftReadError = {
      id: await idField.isEditable(),
      label: await labelField.isEditable(),
      host: await hostField.isEditable(),
    };
    assert.deepEqual(fieldsEditableDuringExistingDraftReadError, {
      id: false,
      label: false,
      host: false,
    });
    const testEnabledDuringExistingDraftReadError = await testButton.isEnabled();
    const saveEnabledDuringExistingDraftReadError = await saveButton.isEnabled();
    const deleteEnabledDuringExistingDraftReadError = await deleteButton.isEnabled();
    assert.equal(testEnabledDuringExistingDraftReadError, false);
    assert.equal(saveEnabledDuringExistingDraftReadError, false);
    assert.equal(deleteEnabledDuringExistingDraftReadError, false);
    assert.equal(
      await page.getByTestId("server-chromium-no-sandbox").isEnabled(),
      false,
    );
    assert.equal(
      await page.getByTestId("server-accept-new-host-key").isEnabled(),
      false,
    );
    assert.equal(await labelField.inputValue(), dirtyLabel);
    assert.equal(await hostField.inputValue(), dirtyHost);
    await captureMaskedScreenshot(
      context,
      page,
      "server-editor-first-read-write-guard-existing-draft-error.png",
    );
    await context.writeArtifactJson(
      "server-editor-first-read-write-guard-existing-draft-error-state.json",
      {
        retentionReason:
          "Key successful UI evidence: a second list-read failure blocks an existing editor while retaining its unsaved draft.",
        injectedReadStatus: secondFailureResponse.status(),
        displayedReadError: INJECTED_READ_ERROR,
        draft: { id: await idField.inputValue(), label: await labelField.inputValue(), host: await hostField.inputValue() },
        fieldsEditable: fieldsEditableDuringExistingDraftReadError,
        testConnectionEnabled: testEnabledDuringExistingDraftReadError,
        saveEnabled: saveEnabledDuringExistingDraftReadError,
        deleteEnabled: deleteEnabledDuringExistingDraftReadError,
        serverWriteRequests: [...serverWriteRequests],
        serversStoreUnchanged:
          (await readFile(serversStore, "utf8")) === originalServersStore,
      },
    );

    const secondExplicitRetry = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === gateway.baseUrl &&
          url.pathname === "/api/servers" &&
          response.request().method() === "GET"
        );
      },
      { timeout: 15_000 },
    );
    await page.getByTestId("server-list-read-retry").click();
    const secondRetryResponse = await secondExplicitRetry;
    serverListResponses.push({
      method: secondRetryResponse.request().method(),
      status: secondRetryResponse.status(),
    });
    assert.equal(secondRetryResponse.status(), 200);
    await editorReadError.waitFor({ state: "detached", timeout: 15_000 });
    assert.equal(await idField.inputValue(), COLLISION_SERVER_ID);
    assert.equal(await labelField.inputValue(), dirtyLabel);
    assert.equal(await hostField.inputValue(), dirtyHost);
    assert.equal(await idField.isEditable(), false);
    assert.equal(await labelField.isEditable(), true);
    assert.equal(await hostField.isEditable(), true);
    assert.equal(await testButton.isEnabled(), true);
    assert.equal(await saveButton.isEnabled(), true);
    assert.equal(await deleteButton.isEnabled(), true);
    await captureMaskedScreenshot(
      context,
      page,
      "server-editor-first-read-write-guard-recovered-dirty-draft.png",
    );

    assert.equal(injectedServerListFailures.length, 2);
    assert.deepEqual(
      injectedServerListFailures,
      [
        { method: "GET", status: 503 },
        { method: "GET", status: 503 },
      ],
    );
    assert.deepEqual(serverListResponses, [
      { method: "GET", status: 503 },
      { method: "GET", status: 200 },
      { method: "GET", status: 503 },
      { method: "GET", status: 200 },
    ]);
    assert.deepEqual(serverWriteRequests, [], "the test must never submit a server mutation");
    assert.equal(
      await readFile(serversStore, "utf8"),
      originalServersStore,
      "the owned Gateway server configuration must remain byte-for-byte unchanged",
    );

    await context.writeArtifactJson("server-editor-first-read-write-guard.json", {
      gatewayBaseUrl: gateway.baseUrl,
      fixtureServerId: COLLISION_SERVER_ID,
      gatewayProfilePersistedBeforeReload: persistedProfile,
      injectedFirstListReadStatus: serverListResponses[0]?.status ?? null,
      visibleReadError: INJECTED_READ_ERROR,
      initialErrorFieldsEditable: initialErrorFieldsEditable,
      saveEnabledDuringInitialReadError: saveEnabledDuringInitialReadError,
      existingDraftReadFailureDisabledActions: {
        fieldsEditable: fieldsEditableDuringExistingDraftReadError,
        testConnectionEnabled: testEnabledDuringExistingDraftReadError,
        saveEnabled: saveEnabledDuringExistingDraftReadError,
        deleteEnabled: deleteEnabledDuringExistingDraftReadError,
      },
      explicitRetryRestoredDirtyDraft: {
        id: await idField.inputValue(),
        label: await labelField.inputValue(),
        host: await hostField.inputValue(),
      },
      explicitRetrySucceeded: serverListResponses.some(
        (response) => response.method === "GET" && response.status === 200,
      ),
      serverWriteRequests,
      serversStoreUnchanged: true,
      mobileSourceTreeSha256: mobileWeb.sourceTreeSha256,
      mobileBundleSha256: mobileWeb.bundleSha256,
      mobileBundleManifestSha256: mobileWeb.sourceManifestSha256,
      mobileBundleExportPerformed: mobileWeb.exportPerformed,
    });
    return {
      firstServerListReadFaulted: true,
      saveDisabledUntilSuccessfulRead: true,
      explicitRefreshRecovered: true,
      dirtyDraftSurvivedReadFailureAndRetry: true,
      serverConfigurationUnchanged: true,
    };
  },
);

async function connectInitialProfile(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

async function captureMaskedScreenshot(context, page, name) {
  const path = context.pathInArtifacts(name);
  const sensitiveFields = page.locator(
    'input[type="password"], input[name*="token"], input[name*="secret"], input[name*="password"]',
  );
  await page.screenshot({
    path,
    fullPage: true,
    animations: "disabled",
    mask: [sensitiveFields],
    maskColor: "#000000",
  });
  return path;
}

async function triggerMobileAppActiveRefresh(page) {
  await page.evaluate(() => {
    // react-native-web forwards this real visibility event to AppState listeners.
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function requiredSha256Pin(name) {
  const value = process.env[name];
  assert.match(value ?? "", /^[a-f0-9]{64}$/, `${name} must be an explicit SHA-256 pin`);
  return value;
}

function requiredAbsolutePath(name) {
  const value = process.env[name];
  assert.ok(value && isAbsolute(value), `${name} must be an explicit absolute path`);
  assert.equal(resolve(value), value, `${name} must be normalized`);
  return value;
}
