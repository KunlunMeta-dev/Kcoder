import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { reuseMobileWebExport } from "../../harness/mobile-web-export-reuse.mjs";
import { runE2E, waitFor } from "../../harness/run-context.mjs";

const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
const SERVER_A_ID = "cas-server-a";
const SERVER_B_ID = "cas-server-b";
const SERVER_A_LABEL = "CAS owned Gateway A server";
const SERVER_B_LABEL = "CAS owned Gateway B server";

await runE2E(
  import.meta.url,
  {
    testId: "mobile-qa-server-editor-profile-switch-cas",
    tier: "model-independent",
    modelPolicy:
      "real Mobile Web with two isolated authenticated mock Gateways; delayed HTTP read/write races; no provider/model request",
  },
  async (context) => {
    const sourceTreeSha256 = requiredSha256Pin(
      "KCODER_E2E_SERVER_EDITOR_CAS_SOURCE_TREE_SHA256",
    );
    const bundleSha256 = requiredSha256Pin(
      "KCODER_E2E_SERVER_EDITOR_CAS_BUNDLE_SHA256",
    );
    const manifestSha256 = requiredSha256Pin(
      "KCODER_E2E_SERVER_EDITOR_CAS_MANIFEST_SHA256",
    );
    const bundleRoot = requiredAbsolutePath(
      "KCODER_E2E_SERVER_EDITOR_CAS_BUNDLE_ROOT",
    );
    const manifestPath = requiredAbsolutePath(
      "KCODER_E2E_SERVER_EDITOR_CAS_MANIFEST_PATH",
    );
    const mobileWeb = await reuseMobileWebExport(context, {
      bundleRoot,
      manifestPath,
      expectedSourceTreeSha256: sourceTreeSha256,
      expectedManifestSha256: manifestSha256,
      expectedBundleSha256: bundleSha256,
      label: "server-editor-profile-switch-cas-mobile-web",
      outputName: "mobile-web-export",
    });
    assert.equal(mobileWeb.sourceTreeSha256, sourceTreeSha256);
    assert.equal(mobileWeb.sourceManifestSha256, manifestSha256);
    assert.equal(mobileWeb.bundleSha256, bundleSha256);
    assert.equal(mobileWeb.bundleFileCount, 37);
    assert.equal(mobileWeb.exportPerformed, false);

    const workspaceA = context.pathInState("workspace-a");
    const workspaceB = context.pathInState("workspace-b");
    await Promise.all([
      mkdir(workspaceA, { recursive: true }),
      mkdir(workspaceB, { recursive: true }),
    ]);
    const serversStoreA = await context.writeStateJson("servers-a.json", [
      serverFixture(SERVER_A_ID, SERVER_A_LABEL, "192.0.2.101", "/srv/cas-a"),
    ]);
    const serversStoreB = await context.writeStateJson("servers-b.json", [
      serverFixture(SERVER_B_ID, SERVER_B_LABEL, "192.0.2.102", "/srv/cas-b"),
    ]);
    const originalServersA = await readFile(serversStoreA, "utf8");
    const originalServersB = await readFile(serversStoreB, "utf8");

    const gatewayA = await startGateway(context, {
      auth: true,
      label: "server-editor-profile-cas-gateway-a",
      workspace: workspaceA,
      serversStore: serversStoreA,
      env: {
        KCODER_STUDIO_MOCK: "1",
        KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
      },
    });
    const gatewayB = await startGateway(context, {
      auth: true,
      label: "server-editor-profile-cas-gateway-b",
      workspace: workspaceB,
      serversStore: serversStoreB,
      env: {
        KCODER_STUDIO_MOCK: "1",
        KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
        KCODER_STUDIO_MOBILE_WEB_ORIGINS: gatewayA.baseUrl,
      },
    });
    assert.notEqual(gatewayA.port, gatewayB.port);

    const chromium = await startChromium(context, {
      label: "server-editor-profile-cas-chromium",
    });
    const page = await chromium.browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 390, height: 844 });

    const observedServerRequests = [];
    const observedRpcMethods = [];
    page.on("websocket", (socket) => {
      let gatewayRole = null;
      try {
        const origin = new URL(socket.url()).origin;
        gatewayRole = origin === gatewayA.baseUrl ? "A" : origin === gatewayB.baseUrl ? "B" : null;
      } catch {}
      socket.on("framesent", (event) => {
        try {
          const frame = JSON.parse(String(event.payload));
          if (typeof frame.method === "string") {
            observedRpcMethods.push({ gatewayRole, method: frame.method });
          }
        } catch {}
      });
    });
    for (const [role, gateway] of [["A", gatewayA], ["B", gatewayB]]) {
      page.on("request", (request) => {
        const url = safeUrl(request.url());
        if (!url || url.origin !== gateway.baseUrl || !url.pathname.startsWith("/api/servers")) return;
        observedServerRequests.push({
          gatewayRole: role,
          method: request.method(),
          pathname: url.pathname,
          bearerFingerprint: bearerFingerprint(request.headers()),
        });
      });
    }

    await connectInitialProfile(page, gatewayA);
    const profileA = await readProfile(page, gatewayA.baseUrl);
    registerProfileSecrets(context, profileA);
    await openDrawerSettings(context, page);
    await clickAddGateway(page);
    await visibleTestId(page, "welcome-direct-connection").click();
    await visibleTestId(page, "gateway-endpoint").fill(gatewayB.baseUrl);
    await visibleTestId(page, "gateway-token").fill(gatewayB.authToken);
    const connectBRead = page.waitForResponse((response) =>
      matchesServerRead(response, gatewayB), { timeout: 30_000 });
    await visibleTestId(page, "gateway-connect").click();
    await visibleTestId(page, "new-workspace").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    const connectBResponse = await connectBRead;
    assert.equal(connectBResponse.status(), 200);
    assert.deepEqual(serverIds(await connectBResponse.json()), [SERVER_B_ID]);
    const profileB = await readProfile(page, gatewayB.baseUrl);
    registerProfileSecrets(context, profileB);
    assert.notEqual(profileA.id, profileB.id);
    assert.notEqual(profileA.accessToken, profileB.accessToken);
    await waitForStoredActiveProfile(page, profileB.id);

    // Select A, open its real editor, and pause an authenticated A list read.
    await openDrawerSettings(context, page);
    const initialARead = page.waitForResponse((response) =>
      matchesServerRead(response, gatewayA), { timeout: 30_000 });
    await switchToProfile(page, profileA);
    const initialAResponse = await initialARead;
    assert.equal(initialAResponse.status(), 200);
    assert.deepEqual(serverIds(await initialAResponse.json()), [SERVER_A_ID]);
    await openDrawerSettings(context, page);
    await enterServerEditor(page, SERVER_A_ID);

    const releaseAGet = deferred();
    const aPutPaused = deferred();
    const releaseAPut = deferred();
    let delayNextAGet = false;
    let delayNextAPut = false;
    let delayedAGetRequest = null;
    let delayedAPutRequest = null;
    await page.route(
      (value) => {
        const url = safeUrl(value);
        return Boolean(
          url &&
            url.origin === gatewayA.baseUrl &&
            (url.pathname === "/api/servers" ||
              url.pathname === `/api/servers/${SERVER_A_ID}`),
        );
      },
      async (route) => {
        const request = route.request();
        const url = safeUrl(request.url());
        if (
          delayNextAGet &&
          request.method() === "GET" &&
          url?.pathname === "/api/servers"
        ) {
          delayNextAGet = false;
          delayedAGetRequest = {
            method: request.method(),
            pathname: url.pathname,
            bearerFingerprint: bearerFingerprint(request.headers()),
          };
          await releaseAGet.promise;
        } else if (
          delayNextAPut &&
          request.method() === "PUT" &&
          url?.pathname === `/api/servers/${SERVER_A_ID}`
        ) {
          delayNextAPut = false;
          const body = request.postDataJSON();
          delayedAPutRequest = {
            method: request.method(),
            pathname: url.pathname,
            bearerFingerprint: bearerFingerprint(request.headers()),
            submittedId: body?.id ?? null,
            submittedLabel: body?.label ?? null,
            submittedHost: body?.host ?? null,
          };
          aPutPaused.resolve();
          await releaseAPut.promise;
        }
        await route.continue();
      },
    );

    let phase = "A editor GET race";
    try {
      delayNextAGet = true;
      const delayedAGetResponsePromise = page.waitForResponse(
        (response) => matchesServerRead(response, gatewayA),
        { timeout: 30_000 },
      );
      await triggerMobileAppActiveRefresh(page);
      await waitFor(
        () => delayedAGetRequest,
        15_000,
        "A editor refresh GET paused at the browser route",
        50,
        context.abortSignal,
      );
      assert.equal(delayedAGetRequest.bearerFingerprint, shortHash(profileA.accessToken));
      assert.equal(await isStoredActiveProfile(page, profileA.id), true);

      // The A editor is clean, so returning to Settings has no discard dialog.
      await page.getByLabel("返回", { exact: true }).click();
      await visibleTestId(page, "diagnostics-settings").waitFor({
        state: "visible",
        timeout: 15_000,
      });
      const switchBRead = page.waitForResponse((response) =>
        matchesServerRead(response, gatewayB), { timeout: 30_000 });
      await switchToProfile(page, profileB);
      const switchBResponse = await switchBRead;
      assert.equal(switchBResponse.status(), 200);
      assert.deepEqual(serverIds(await switchBResponse.json()), [SERVER_B_ID]);
      await openDrawerSettings(context, page);
      await enterServerEditor(page, SERVER_B_ID);
      const bLabelField = page.getByLabel("显示名称", { exact: true });
      const bHostField = page.getByLabel("SSH 主机", { exact: true });
      const bDraftAfterGet = {
        id: SERVER_B_ID,
        label: "B draft remains after late A list response",
        host: "192.0.2.202",
      };
      await bLabelField.fill(bDraftAfterGet.label);
      await bHostField.fill(bDraftAfterGet.host);
      const bEditorUrlAfterGetDraft = page.url();

      releaseAGet.resolve();
      const delayedAGetResponse = await delayedAGetResponsePromise;
      assert.equal(delayedAGetResponse.status(), 200);
      assert.deepEqual(serverIds(await delayedAGetResponse.json()), [SERVER_A_ID]);
      await settleRenderedFrame(page);
      assert.equal(await isStoredActiveProfile(page, profileB.id), true);
      assert.equal(page.url(), bEditorUrlAfterGetDraft, "late A GET must not navigate away from B editor");
      assert.equal(await page.getByTestId("server-id").inputValue(), bDraftAfterGet.id);
      assert.equal(await bLabelField.inputValue(), bDraftAfterGet.label);
      assert.equal(await bHostField.inputValue(), bDraftAfterGet.host);
      assert.equal(await visibleTextCount(page, SERVER_A_LABEL), 0, "B's loaded server list must not be replaced by A's response");
      assert.equal(await visibleTextCount(page, SERVER_B_LABEL), 1);
      await captureMaskedScreenshot(
        context,
        page,
        "server-editor-profile-cas-b-draft-after-late-a-get.png",
      );
      await context.writeArtifactJson("server-editor-profile-cas-after-a-get.json", {
        retentionReason:
          "Key UI evidence: B selection and unsaved draft remain visible after the delayed authenticated A server-list response arrives.",
        delayedARequest: delayedAGetRequest,
        lateAResponseStatus: delayedAGetResponse.status(),
        lateAResponseServerIds: [SERVER_A_ID],
        activeProfileIdSha256: shortHash(profileB.id),
        editorUrlUnchanged: true,
        visibleServerLabels: {
          A: await visibleTextCount(page, SERVER_A_LABEL),
          B: await visibleTextCount(page, SERVER_B_LABEL),
        },
        bDraft: {
          id: await page.getByTestId("server-id").inputValue(),
          label: await bLabelField.inputValue(),
          host: await bHostField.inputValue(),
        },
      });

      phase = "A editor PUT race";
      await backWithDiscardConfirmation(page);
      await visibleTestId(page, "diagnostics-settings").waitFor({
        state: "visible",
        timeout: 15_000,
      });
      const switchARead = page.waitForResponse((response) =>
        matchesServerRead(response, gatewayA), { timeout: 30_000 });
      await switchToProfile(page, profileA);
      const switchAResponse = await switchARead;
      assert.equal(switchAResponse.status(), 200);
      assert.deepEqual(serverIds(await switchAResponse.json()), [SERVER_A_ID]);
      await openDrawerSettings(context, page);
      await enterServerEditor(page, SERVER_A_ID);
      const aLabelField = page.getByLabel("显示名称", { exact: true });
      const aHostField = page.getByLabel("SSH 主机", { exact: true });
      const aDraftToSave = {
        id: SERVER_A_ID,
        label: "A save completes after B becomes active",
        host: "192.0.2.201",
      };
      await aLabelField.fill(aDraftToSave.label);
      await aHostField.fill(aDraftToSave.host);
      delayNextAPut = true;
      const delayedAPutResponsePromise = page.waitForResponse(
        (response) => matchesServerWrite(response, gatewayA, SERVER_A_ID, "PUT"),
        { timeout: 30_000 },
      );
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await waitFor(
        () => delayedAPutRequest !== null,
        15_000,
        "A editor save PUT paused at the browser route",
        50,
        context.abortSignal,
      );
      assert.equal(delayedAPutRequest.bearerFingerprint, shortHash(profileA.accessToken));
      assert.deepEqual(
        {
          id: delayedAPutRequest.submittedId,
          label: delayedAPutRequest.submittedLabel,
          host: delayedAPutRequest.submittedHost,
        },
        aDraftToSave,
      );
      assert.equal(await isStoredActiveProfile(page, profileA.id), true);
      assert.equal(await readFile(serversStoreA, "utf8"), originalServersA, "A's Gateway has not committed the paused PUT yet");
      assert.equal(await readFile(serversStoreB, "utf8"), originalServersB);

      // The save remains pending while the dirty A editor is explicitly discarded and B selected.
      await backWithDiscardConfirmation(page);
      await visibleTestId(page, "diagnostics-settings").waitFor({
        state: "visible",
        timeout: 15_000,
      });
      const switchBackBRead = page.waitForResponse((response) =>
        matchesServerRead(response, gatewayB), { timeout: 30_000 });
      await switchToProfile(page, profileB);
      const switchBackBResponse = await switchBackBRead;
      assert.equal(switchBackBResponse.status(), 200);
      assert.deepEqual(serverIds(await switchBackBResponse.json()), [SERVER_B_ID]);
      await openDrawerSettings(context, page);
      await enterServerEditor(page, SERVER_B_ID);
      const bLabelAfterPut = "B draft remains after late A save response";
      const bHostAfterPut = "192.0.2.203";
      await bLabelField.fill(bLabelAfterPut);
      await bHostField.fill(bHostAfterPut);
      const bEditorUrlAfterPutDraft = page.url();

      releaseAPut.resolve();
      const delayedAPutResponse = await delayedAPutResponsePromise;
      assert.equal(delayedAPutResponse.status(), 200);
      const lateASavePayload = await delayedAPutResponse.json();
      assert.equal(lateASavePayload.server?.id, SERVER_A_ID);
      assert.equal(lateASavePayload.server?.label, aDraftToSave.label);
      await settleRenderedFrame(page);
      assert.equal(await isStoredActiveProfile(page, profileB.id), true);
      assert.equal(page.url(), bEditorUrlAfterPutDraft, "late A PUT must not navigate away from B editor");
      assert.equal(await page.getByTestId("server-id").inputValue(), SERVER_B_ID);
      assert.equal(await bLabelField.inputValue(), bLabelAfterPut);
      assert.equal(await bHostField.inputValue(), bHostAfterPut);
      assert.equal(await visibleTextCount(page, SERVER_A_LABEL), 0);
      assert.equal(await visibleTextCount(page, SERVER_B_LABEL), 1);
      assert.equal(await visibleTextCount(page, "成功：配置已保存，旧连接已关闭，请重新打开任务"), 0);
      const savedServersA = JSON.parse(await readFile(serversStoreA, "utf8"));
      assert.equal(savedServersA.find((server) => server.id === SERVER_A_ID)?.label, aDraftToSave.label);
      assert.equal(savedServersA.find((server) => server.id === SERVER_A_ID)?.host, aDraftToSave.host);
      assert.equal(
        await readFile(serversStoreB, "utf8"),
        originalServersB,
        "the late A PUT may update only A's owned server store",
      );
      const aPutCalls = observedServerRequests.filter(
        (request) => request.gatewayRole === "A" && request.method === "PUT" && request.pathname === `/api/servers/${SERVER_A_ID}`,
      );
      const bPutCalls = observedServerRequests.filter(
        (request) => request.gatewayRole === "B" && request.method === "PUT",
      );
      assert.equal(aPutCalls.length, 1);
      assert.equal(bPutCalls.length, 0);
      assert.equal(aPutCalls[0].bearerFingerprint, shortHash(profileA.accessToken));
      const turnStartRequests = observedRpcMethods.filter(
        ({ method }) => method === "turn/start",
      ).length;
      assert.equal(turnStartRequests, 0, "the profile CAS test must not submit a model turn");
      await captureMaskedScreenshot(
        context,
        page,
        "server-editor-profile-cas-b-draft-after-late-a-put.png",
      );
      await context.writeArtifactJson("server-editor-profile-cas-after-a-put.json", {
        retentionReason:
          "Key UI and persistence evidence: the delayed A save reaches only A's Gateway after B is active, leaving B's editor draft, route, and configuration intact.",
        delayedARequest: delayedAPutRequest,
        lateAResponseStatus: delayedAPutResponse.status(),
        lateAResponseServerId: lateASavePayload.server?.id ?? null,
        lateAResponseLabel: lateASavePayload.server?.label ?? null,
        activeProfileIdSha256: shortHash(profileB.id),
        editorUrlUnchanged: true,
        aStoreUpdatedForOwnedWrite: true,
        bStoreByteIdentical: true,
        aPutCalls: aPutCalls.length,
        bPutCalls: bPutCalls.length,
        bDraft: {
          id: await page.getByTestId("server-id").inputValue(),
          label: await bLabelField.inputValue(),
          host: await bHostField.inputValue(),
        },
      });

      const result = {
        getRace: {
          delayedARequestObserved: true,
          activeBUnchanged: true,
          bEditorRouteUnchanged: true,
          bDraftRetained: true,
          aServerDidNotReplaceBList: true,
        },
        putRace: {
          aPutCompletedAfterBSelected: true,
          aStoreUpdatedOnlyForA: true,
          bStoreByteIdentical: true,
          bEditorRouteAndDraftRetained: true,
          noAResultMessageLeakedIntoB: true,
        },
        turnStartRequests,
        providerCalls: turnStartRequests,
        providerCallsMeasuredBy:
          "No turn/start RPCs were sent; both owned Gateways ran KCODER_STUDIO_MOCK=1.",
        rpcMethods: observedRpcMethods,
        serverRequests: observedServerRequests,
        mobileSourceTreeSha256: mobileWeb.sourceTreeSha256,
        mobileBundleSha256: mobileWeb.bundleSha256,
        mobileManifestSha256: mobileWeb.sourceManifestSha256,
        mobileBundleExportPerformed: mobileWeb.exportPerformed,
      };
      await context.writeArtifactJson("server-editor-profile-switch-cas.json", result);
      return result;
    } catch (error) {
      await captureMaskedScreenshot(
        context,
        page,
        "server-editor-profile-switch-cas-failure.png",
      ).catch(() => {});
      await context.writeArtifactJson("server-editor-profile-switch-cas-failure-state.json", {
        retentionReason:
          "Failure evidence for a delayed server-editor request/profile-switch boundary.",
        phase,
        route: safeUrl(page.url())?.pathname ?? null,
        activeProfileIdSha256: await page.evaluate(({ key }) => {
          try {
            const id = JSON.parse(localStorage.getItem(key) ?? "null")?.activeId;
            return typeof id === "string" ? id : null;
          } catch {
            return null;
          }
        }, { key: PROFILE_INDEX_KEY }).catch(() => null),
        delayedAGetRequest: delayedAGetRequest,
        delayedAPutRequest: delayedAPutRequest,
        serverRequests: observedServerRequests,
        originalServersA,
        originalServersB,
        serversAAfterFailure: await readFile(serversStoreA, "utf8").catch(() => null),
        serversBAfterFailure: await readFile(serversStoreB, "utf8").catch(() => null),
        errorName: error?.name ?? "Error",
      }).catch(() => {});
      throw error;
    } finally {
      releaseAGet.resolve();
      releaseAPut.resolve();
    }
  },
);

async function connectInitialProfile(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', {
      timeout: 30_000,
    }),
    page.locator('button[type="submit"]').click(),
  ]);
  await visibleTestId(page, "welcome-direct-connection").click();
  await visibleTestId(page, "gateway-endpoint").fill(gateway.baseUrl);
  await visibleTestId(page, "gateway-token").fill(gateway.authToken);
  const serverRead = page.waitForResponse((response) =>
    matchesServerRead(response, gateway), { timeout: 30_000 });
  await visibleTestId(page, "gateway-connect").click();
  await visibleTestId(page, "new-workspace").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  const response = await serverRead;
  assert.equal(response.status(), 200);
  assert.deepEqual(serverIds(await response.json()), [SERVER_A_ID]);
}

async function openDrawerSettings(context, page) {
  try {
    const menu = page.locator(
      '[aria-label="打开任务列表"]:visible, [aria-label="打开导航"]:visible',
    );
    await menu.first().click();
    const drawer = visibleTestId(page, "mobile-drawer");
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    await drawer.getByLabel("设置", { exact: true }).click();
    await visibleTestId(page, "diagnostics-settings").waitFor({
      state: "visible",
      timeout: 15_000,
    });
  } catch (error) {
    await captureMaskedScreenshot(
      context,
      page,
      "server-editor-profile-cas-settings-navigation-failure.png",
    ).catch(() => {});
    await context.writeArtifactJson(
      "server-editor-profile-cas-settings-navigation-failure.json",
      {
        retentionReason: "Setup failure evidence for the real Mobile Settings navigation before a CAS boundary was reached.",
        htmlLanguage: await page.locator("html").getAttribute("lang").catch(() => null),
        route: safeUrl(page.url())?.pathname ?? null,
        drawerVisible: await visibleTestId(page, "mobile-drawer").count().catch(() => 0),
        drawerText: await visibleTestId(page, "mobile-drawer").innerText().catch(() => null),
        errorName: error?.name ?? "Error",
      },
    ).catch(() => {});
    throw error;
  }
}

async function clickAddGateway(page) {
  await (await visibleLocalizedText(page, "添加 Gateway", "Add Gateway")).click();
}

async function switchToProfile(page, profile) {
  await (
    await visibleLocalizedLabel(
      page,
      `切换到 ${profile.label}`,
      `Switch to ${profile.label}`,
    )
  ).click();
  await waitForStoredActiveProfile(page, profile.id);
  await visibleTestId(page, "new-workspace").waitFor({
    state: "visible",
    timeout: 15_000,
  });
}

async function enterServerEditor(page, serverId) {
  await visibleTestId(page, `settings-host-${serverId}`).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await visibleTestId(page, `settings-host-${serverId}`).click();
  await visibleTestId(page, "host-details-route").waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await page.getByText("编辑 SSH 配置", { exact: true }).click();
  await visibleTestId(page, "server-editor-route").waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.value === expected,
    { selector: '[data-testid="server-id"]', expected: serverId },
    { timeout: 15_000 },
  );
}

async function backWithDiscardConfirmation(page) {
  const dialogAccepted = page.waitForEvent("dialog", { timeout: 10_000 }).then(async (dialog) => {
    assert.equal(dialog.type(), "confirm");
    assert.match(dialog.message(), /放弃未保存的更改/);
    await dialog.accept();
  });
  await Promise.all([
    page.getByLabel("返回", { exact: true }).click(),
    dialogAccepted,
  ]);
}

async function triggerMobileAppActiveRefresh(page) {
  await page.evaluate(() => {
    // react-native-web forwards a real visibility event to AppState listeners.
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function settleRenderedFrame(page) {
  await page.evaluate(() => new Promise((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
  }));
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

async function readProfile(page, baseUrl) {
  const profile = await page.evaluate(({ profileIndexKey, expectedBaseUrl }) => {
    const index = JSON.parse(localStorage.getItem(profileIndexKey) ?? "null");
    const profiles = Array.isArray(index) ? index : index?.profiles;
    if (!Array.isArray(profiles)) return null;
    const stored = profiles.find((item) => item?.baseUrl === expectedBaseUrl);
    if (!stored) return null;
    let key = stored.secretKey;
    if (typeof key !== "string") {
      let hash = 0x811c9dc5;
      for (let index = 0; index < stored.id.length; index += 1) {
        hash ^= stored.id.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      key = `kcoder-studio-mobile.gateway-secret.${(hash >>> 0).toString(16).padStart(8, "0")}`;
    }
    const secret = JSON.parse(localStorage.getItem(key) ?? "null");
    if (typeof secret?.accessToken !== "string" || typeof secret?.rpcToken !== "string") return null;
    return {
      id: stored.id,
      label: stored.label,
      baseUrl: stored.baseUrl,
      accessToken: secret.accessToken,
      rpcToken: secret.rpcToken,
    };
  }, { profileIndexKey: PROFILE_INDEX_KEY, expectedBaseUrl: baseUrl });
  assert.ok(profile, "the owned browser must have persisted the expected Gateway profile");
  return profile;
}

function registerProfileSecrets(context, profile) {
  if (profile.accessToken.length >= 8) context.registerSecret(profile.accessToken);
  if (profile.rpcToken.length >= 8) context.registerSecret(profile.rpcToken);
}

async function waitForStoredActiveProfile(page, profileId) {
  await page.waitForFunction(
    ({ key, expected }) => {
      try {
        return JSON.parse(localStorage.getItem(key) ?? "null")?.activeId === expected;
      } catch {
        return false;
      }
    },
    { key: PROFILE_INDEX_KEY, expected: profileId },
    { timeout: 15_000 },
  );
}

async function isStoredActiveProfile(page, profileId) {
  return page.evaluate(({ key, expected }) => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null")?.activeId === expected;
    } catch {
      return false;
    }
  }, { key: PROFILE_INDEX_KEY, expected: profileId });
}

async function visibleTextCount(page, value) {
  return page.getByText(value, { exact: true }).and(page.locator(":visible")).count();
}

async function visibleLocalizedText(page, chinese, english, scope = page) {
  const chineseText = scope.getByText(chinese, { exact: true }).and(page.locator(":visible"));
  if (await chineseText.count()) return chineseText;
  return scope.getByText(english, { exact: true }).and(page.locator(":visible"));
}

async function visibleLocalizedLabel(page, chinese, english, scope = page) {
  const chineseLabel = scope.getByLabel(chinese, { exact: true }).and(page.locator(":visible"));
  if (await chineseLabel.count()) return chineseLabel;
  return scope.getByLabel(english, { exact: true }).and(page.locator(":visible"));
}

function visibleTestId(page, testId) {
  return page.locator(`[data-testid="${testId}"]:visible`);
}

function matchesServerRead(response, gateway) {
  const url = safeUrl(response.url());
  return Boolean(
    url &&
      url.origin === gateway.baseUrl &&
      url.pathname === "/api/servers" &&
      response.request().method() === "GET",
  );
}

function matchesServerWrite(response, gateway, serverId, method) {
  const url = safeUrl(response.url());
  return Boolean(
    url &&
      url.origin === gateway.baseUrl &&
      url.pathname === `/api/servers/${serverId}` &&
      response.request().method() === method,
  );
}

function serverIds(payload) {
  assert.ok(payload && Array.isArray(payload.servers), "Gateway /api/servers response must contain a server list");
  return payload.servers.map((server) => server.id);
}

function serverFixture(id, label, host, workspace) {
  return {
    id,
    label,
    description: "Owned isolated profile-CAS fixture",
    runtime: "kcoder",
    transport: "ssh",
    host,
    user: "fixture-user",
    port: 22,
    command: "kcoder",
    workspace,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function bearerFingerprint(headers) {
  const value = headers.authorization ?? headers.Authorization;
  const match = typeof value === "string" ? /^Bearer\s+(.+)$/i.exec(value) : null;
  return match ? shortHash(match[1]) : null;
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function requiredSha256Pin(name) {
  const value = process.env[name];
  assert.match(value ?? "", /^[a-f0-9]{64}$/, `${name} must be an explicit SHA-256 pin`);
  return value;
}

function requiredAbsolutePath(name) {
  const value = process.env[name];
  assert.ok(value && isAbsolute(value), `${name} must be an explicit absolute path`);
  const normalized = resolve(value);
  assert.equal(normalized, value, `${name} must be normalized`);
  return normalized;
}
