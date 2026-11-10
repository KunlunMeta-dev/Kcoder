import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { restorePinnedGatewayMobileDeployment } from "../../harness/mobile-pinned-gateway-deployment.mjs";
import { runE2E, waitFor } from "../../harness/run-context.mjs";

const PROFILE_INDEX_KEY = "kcoder-studio-mobile.gateway-profiles.v2";
const SERVER_A_ID = "cas-server-a";
const SERVER_B_ID = "cas-server-b";
const SERVER_A_LABEL = "CAS owned Gateway A server";
const SERVER_A_NEW_LABEL = "CAS owned Gateway A server v2";
const SERVER_B_LABEL = "CAS owned Gateway B server";
const MOBILE_MOUNT = "/mobile";
const activationAbaSmoke = process.argv.includes("--activation-aba-smoke");

await runE2E(
  import.meta.url,
  {
    testId: "mobile-qa-server-editor-profile-switch-cas",
    tier: "model-independent",
    case: activationAbaSmoke ? "activation-aba-smoke" : "profile-switch-cas-full",
    modelPolicy:
      "real React Mobile Web with two isolated authenticated mock Gateways; local fixture-only HTTP races; no Rust app-server, Provider, or model request",
  },
  async (context) => {
    const pinnedMobile = await restorePinnedGatewayMobileDeployment(context, {
      outputName: "server-editor-profile-switch-cas-mobile-web",
    });
    const { mobileWeb, deployment } = pinnedMobile;
    assert.ok(mobileWeb.bundleFiles.length > 0, "the pinned Mobile archive must expose its verified resource table");
    assert.equal(deployment.resourceCount, mobileWeb.bundleFiles.length,
      "the production deployment inventory must match the caller-pinned archive resources");
    assert.equal(deployment.physicalFileCount, deployment.resourceCount + 1,
      "the deployment must contain each verified resource and its generated production manifest");
    assert.equal(deployment.inventoryVerifiedAgainstArchive, true);

    const workspaceA = context.pathInState("workspace-a");
    const workspaceB = context.pathInState("workspace-b");
    const desktopWebRoot = context.pathInState("empty-desktop-web-root");
    await Promise.all([
      mkdir(workspaceA, { recursive: true }),
      mkdir(workspaceB, { recursive: true }),
      mkdir(desktopWebRoot, { recursive: true, mode: 0o700 }),
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
        KCODER_STUDIO_WEB_ROOT: desktopWebRoot,
        KCODER_STUDIO_MOBILE_WEB_ROOT: deployment.path,
      },
    });
    const gatewayB = await startGateway(context, {
      auth: true,
      label: "server-editor-profile-cas-gateway-b",
      workspace: workspaceB,
      serversStore: serversStoreB,
      env: {
        KCODER_STUDIO_MOCK: "1",
        KCODER_STUDIO_WEB_ROOT: desktopWebRoot,
        KCODER_STUDIO_MOBILE_WEB_ROOT: deployment.path,
        KCODER_STUDIO_MOBILE_WEB_ORIGINS: gatewayA.baseUrl,
      },
    });
    assert.notEqual(gatewayA.port, gatewayB.port);
    const mobileEntryUrl = await verifyProductionMobileMount(context, gatewayA, "A");
    await verifyProductionMobileMount(context, gatewayB, "B");

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

    const profileASetup = await connectAuthenticatedMobileProfile(context, page, gatewayA, {
      role: "A",
      expectedServerId: SERVER_A_ID,
      mobileEntryUrl,
      observedServerRequests,
    });
    const profileA = profileASetup.profile;
    await openSettingsHome(context, page);
    await clickAddGateway(context, page);
    const profileBSetup = await connectAuthenticatedMobileProfile(context, page, gatewayB, {
      role: "B",
      expectedServerId: SERVER_B_ID,
      observedServerRequests,
    });
    const profileB = profileBSetup.profile;
    assert.notEqual(profileA.id, profileB.id);
    assert.notEqual(profileA.accessToken, profileB.accessToken);
    await waitForStoredActiveProfile(page, profileB.id);

    if (activationAbaSmoke) {
      return await runActivationAbaSmoke(context, page, {
        gatewayA,
        gatewayB,
        serversStoreB,
        profileA,
        profileB,
        profileABootstrap: profileASetup.bootstrapEvidence,
        profileBBootstrap: profileBSetup.bootstrapEvidence,
        originalServersB,
        observedRpcMethods,
      });
    }

    // Select A, open its real editor, and pause an authenticated A list read.
    await openSettingsHome(context, page);
    const initialARead = page.waitForResponse((response) =>
      matchesServerRead(response, gatewayA), { timeout: 30_000 });
    await switchToProfile(context, page, profileA);
    const initialAResponse = await initialARead;
    assert.equal(initialAResponse.status(), 200);
    assert.deepEqual(serverIds(await initialAResponse.json()), [SERVER_A_ID]);
    await openSettingsHome(context, page);
    await enterServerEditor(context, page, SERVER_A_ID);

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
      await switchToProfile(context, page, profileB);
      const switchBResponse = await switchBRead;
      assert.equal(switchBResponse.status(), 200);
      assert.deepEqual(serverIds(await switchBResponse.json()), [SERVER_B_ID]);
      await openSettingsHome(context, page);
      await enterServerEditor(context, page, SERVER_B_ID);
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
      await switchToProfile(context, page, profileA);
      const switchAResponse = await switchARead;
      assert.equal(switchAResponse.status(), 200);
      assert.deepEqual(serverIds(await switchAResponse.json()), [SERVER_A_ID]);
      await openSettingsHome(context, page);
      await enterServerEditor(context, page, SERVER_A_ID);
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
      await switchToProfile(context, page, profileB);
      const switchBackBResponse = await switchBackBRead;
      assert.equal(switchBackBResponse.status(), 200);
      assert.deepEqual(serverIds(await switchBackBResponse.json()), [SERVER_B_ID]);
      await openSettingsHome(context, page);
      await enterServerEditor(context, page, SERVER_B_ID);
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
      const turnStartCount = observedRpcMethods.filter(
        ({ method }) => method === "turn/start",
      ).length;
      assert.equal(turnStartCount, 0, "the profile CAS test must not submit a model turn");
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
        turnStartCount,
        noLiveModelConfigured: true,
        rpcMethods: observedRpcMethods,
        serverRequests: observedServerRequests,
        mobileSourceTreeSha256: mobileWeb.sourceTreeSha256,
        mobileBundleSha256: mobileWeb.bundleSha256,
        mobileArchiveSha256: mobileWeb.archiveSha256,
        mobileManifestSha256: pinnedMobile.sourceIdentity.snapshotProof.manifestSha256,
        mobileResourceCount: deployment.resourceCount,
        mobileDeploymentManifestSha256: deployment.manifestSha256,
        mobileInventoryVerifiedAgainstArchive: deployment.inventoryVerifiedAgainstArchive,
        mobileProfileBootstraps: {
          a: profileASetup.bootstrapEvidence,
          b: profileBSetup.bootstrapEvidence,
        },
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

async function runActivationAbaSmoke(context, page, {
  gatewayA,
  gatewayB,
  serversStoreB,
  profileA,
  profileB,
  profileABootstrap,
  profileBBootstrap,
  originalServersB,
  observedRpcMethods,
}) {
  const milestones = [];
  const mark = (name) => {
    milestones.push({ ordinal: milestones.length + 1, name, atUnixMs: Date.now() });
    return milestones.at(-1).ordinal;
  };
  const releaseOldResponse = deferred();
  const aReadRequests = [];
  let oldResponseCapture = null;
  let oldResponseFailure = null;
  let oldRouteEntered = false;
  let oldHandlerDone = false;
  let phase = "install A inventory response hold";

  const routeMatcher = (value) => {
    const url = safeUrl(value);
    return Boolean(
      url &&
        url.origin === gatewayA.baseUrl &&
        url.pathname === "/api/servers",
    );
  };
  const routeHandler = async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.continue();
      return;
    }
    const requestProof = requestEvidence(request);
    aReadRequests.push({ ordinal: aReadRequests.length + 1, ...requestProof });
    if (oldRouteEntered) {
      await route.continue();
      return;
    }

    oldRouteEntered = true;
    try {
      const upstream = await route.fetch({ timeout: 15_000 });
      const responseProof = await responseEvidence(upstream);
      oldResponseCapture = { request: requestProof, response: responseProof };
      mark("old-a-gateway-response-fetched-before-browser-delivery");
      await releaseOldResponse.promise;
      await route.fulfill({ response: upstream });
    } catch (error) {
      oldResponseFailure = error;
      await route.abort().catch(() => {});
    } finally {
      oldHandlerDone = true;
    }
  };

  try {
    // RunContext closes this suite-owned page after the stage; avoid Page.unroute's unbounded CDP interception update.
    await page.route(routeMatcher, routeHandler);

    phase = "first A activation captures and holds the authenticated v1 response";
    await openSettingsHome(context, page);
    mark("B-active-before-first-A-activation");
    await switchToProfile(context, page, profileA);
    const held = await waitFor(
      () => oldResponseCapture || oldResponseFailure ? oldResponseCapture ?? { errorName: "Gateway response capture failed" } : null,
      20_000,
      "the first A profile activation fetched its real Gateway inventory before the response was released",
      50,
      context.abortSignal,
    );
    assert.equal(oldResponseFailure, null, "the old A inventory request must reach its owned Gateway");
    assert.ok(held.request && held.response, "the old A Gateway request and response tuple must be captured");
    assert.equal(await isStoredActiveProfile(page, profileA.id), true,
      "the real UI profile selector must make A current while its inventory response is held");
    assert.equal(held.request.method, "GET");
    assert.equal(held.request.origin, gatewayA.baseUrl);
    assert.equal(held.request.pathname, "/api/servers");
    assert.equal(held.request.bearerFingerprint, shortHash(profileA.accessToken),
      "the held A request must use A's Mobile access token");
    assert.equal(held.response.status, 200);
    assert.deepEqual(held.response.serverIds, [SERVER_A_ID]);
    assert.deepEqual(held.response.serverLabels, [SERVER_A_LABEL]);
    const aSelectedWithOldHeldOrdinal = mark("A-selected-with-old-v1-response-still-held");

    phase = "switch A to B while the old A response remains held";
    await openSettingsHome(context, page);
    const bReadPromise = page.waitForResponse(
      (response) => matchesServerRead(response, gatewayB),
      { timeout: 30_000 },
    );
    await switchToProfile(context, page, profileB);
    const bResponse = await bReadPromise;
    const bResponseProof = await responseEvidence(bResponse);
    assert.equal(bResponseProof.status, 200);
    assert.deepEqual(bResponseProof.serverIds, [SERVER_B_ID]);
    assert.deepEqual(bResponseProof.serverLabels, [SERVER_B_LABEL]);
    const bRequestProof = requestEvidence(bResponse.request());
    assert.equal(bRequestProof.bearerFingerprint, shortHash(profileB.accessToken),
      "the B activation request must use B's Mobile access token");
    assert.equal(await isStoredActiveProfile(page, profileB.id), true);
    await openSettingsHome(context, page);
    await openConnectionsSettings(context, page);
    const bRow = await uniqueVisibleTestId(page, `settings-host-${SERVER_B_ID}`);
    assert.match(await bRow.innerText(), new RegExp(escapeRegExp(SERVER_B_LABEL)));
    const bVisibleWithOldAHeldOrdinal = mark("B-inventory-visible-while-old-A-response-held");

    phase = "update only A's run-owned mock Gateway inventory through its authenticated API";
    const aV2Fixture = serverFixture(
      SERVER_A_ID,
      SERVER_A_NEW_LABEL,
      "192.0.2.101",
      "/srv/cas-a",
    );
    const mutationBody = Buffer.from(JSON.stringify(aV2Fixture));
    const mutationResponse = await fetch(`${gatewayA.baseUrl}/api/servers/${SERVER_A_ID}`, {
      method: "PUT",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${profileA.accessToken}`,
        "content-type": "application/json",
        origin: gatewayA.baseUrl,
      },
      body: mutationBody,
    });
    const mutationBytes = Buffer.from(await mutationResponse.arrayBuffer());
    const mutationPayload = parseJsonBuffer(mutationBytes, "owned mock Gateway server fixture update");
    assert.equal(mutationResponse.status, 200,
      "the A v2 fixture update must be accepted by A's owned mock Gateway");
    assert.equal(mutationPayload.server?.id, SERVER_A_ID);
    assert.equal(mutationPayload.server?.label, SERVER_A_NEW_LABEL);
    const mutationProof = {
      method: "PUT",
      origin: gatewayA.baseUrl,
      pathname: `/api/servers/${SERVER_A_ID}`,
      bearerFingerprint: shortHash(profileA.accessToken),
      requestBodySha256: sha256(mutationBody),
      responseStatus: mutationResponse.status,
      responseBodySha256: sha256(mutationBytes),
      returnedServerId: mutationPayload.server.id,
      returnedServerLabel: mutationPayload.server.label,
    };

    phase = "switch B to A and observe the independent v2 inventory request";
    const newAReadPromise = page.waitForResponse(
      (response) => matchesServerRead(response, gatewayA),
      { timeout: 30_000 },
    );
    await switchToProfile(context, page, profileA);
    const newAResponse = await newAReadPromise;
    const newAResponseProof = await responseEvidence(newAResponse);
    const newARequestProof = requestEvidence(newAResponse.request());
    assert.equal(newAResponseProof.status, 200);
    assert.deepEqual(newAResponseProof.serverIds, [SERVER_A_ID]);
    assert.deepEqual(newAResponseProof.serverLabels, [SERVER_A_NEW_LABEL]);
    assert.equal(newARequestProof.bearerFingerprint, shortHash(profileA.accessToken),
      "the independent A reactivation request must still use A's Mobile access token");
    assert.equal(aReadRequests.length, 2,
      "the smoke must use exactly the held A GET and one independent A reactivation GET");
    assert.equal(aReadRequests[1].bearerFingerprint, shortHash(profileA.accessToken));
    const aReactivatedWithNewResponseOrdinal = mark("A-reactivated-with-independent-v2-response");

    await openSettingsHome(context, page);
    await openConnectionsSettings(context, page);
    const aRow = await uniqueVisibleTestId(page, `settings-host-${SERVER_A_ID}`);
    assert.match(await aRow.innerText(), new RegExp(escapeRegExp(SERVER_A_NEW_LABEL)),
      "the new A inventory must be visible before the old A response is released");
    assert.equal(await visibleTextCount(page, SERVER_A_LABEL), 0,
      "the A v1 inventory must already be absent before releasing its old response");
    const newAVisibleOrdinal = mark("new-A-inventory-visible-before-old-response-release");

    phase = "release and compare the exact previously fetched A v1 response";
    const oldDeliveredPromise = page.waitForResponse(
      async (response) => {
        if (!matchesServerRead(response, gatewayA)) return false;
        try {
          return sha256(await response.body()) === held.response.bodySha256;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    );
    const oldReleaseOrdinal = mark("old-A-response-release-requested");
    assert.ok(newAVisibleOrdinal < oldReleaseOrdinal,
      "the new A inventory must be observable before releasing the held response");
    releaseOldResponse.resolve();
    const oldDeliveredResponse = await oldDeliveredPromise;
    await waitFor(
      () => oldHandlerDone ? true : null,
      10_000,
      "the held old A route must finish after its response is released",
      25,
      context.abortSignal,
    );
    const oldDeliveredProof = await responseEvidence(oldDeliveredResponse);
    const oldDeliveredRequestProof = requestEvidence(oldDeliveredResponse.request());
    assert.equal(oldDeliveredProof.status, held.response.status);
    assert.equal(oldDeliveredProof.statusText, held.response.statusText);
    assert.deepEqual(oldDeliveredProof.contractHeaders, held.response.contractHeaders);
    assert.equal(oldDeliveredProof.bodySha256, held.response.bodySha256,
      "the browser must receive the same body fetched before A changed to v2");
    assert.equal(oldDeliveredRequestProof.bearerFingerprint, held.request.bearerFingerprint);
    assert.equal(oldDeliveredRequestProof.pathname, held.request.pathname);
    const oldDeliveredOrdinal = mark("old-A-v1-response-delivered-after-v2");
    assert.ok(oldReleaseOrdinal < oldDeliveredOrdinal);

    phase = "verify A remains on v2 and B's owned state is unchanged";
    await settleRenderedFrame(page);
    assert.equal(await isStoredActiveProfile(page, profileA.id), true,
      "late A v1 must not replace the UI's active A profile");
    assert.equal(await visibleTextCount(page, SERVER_A_NEW_LABEL), 1,
      "late A v1 must not replace the newer A inventory");
    assert.equal(await visibleTextCount(page, SERVER_A_LABEL), 0);
    assert.equal(await visibleTextCount(page, SERVER_B_LABEL), 0);
    assert.equal(await readFile(serversStoreB, "utf8"), originalServersB,
      "the A response and A fixture mutation must leave B's Gateway store byte-identical");
    const profileBAfter = await readProfile(page, gatewayB.baseUrl);
    assert.equal(profileBAfter.id, profileB.id);
    assert.equal(profileBAfter.accessToken, profileB.accessToken,
      "the B profile and credential must remain independently persisted");
    const turnStartCount = observedRpcMethods.filter(({ method }) => method === "turn/start").length;
    assert.equal(turnStartCount, 0, "the activation ABA smoke must not submit a model turn");

    const result = {
      status: "PASS_ACTIVATION_ABA_SMOKE",
      stage: "activation-aba-smoke",
      boundary:
        "real React Mobile UI with two authenticated KCODER_STUDIO_MOCK=1 Gateways; exact A GET response fetched then held; fixture mutation uses A's Mobile bearer; no Rust app-server, Provider, model turn, real Gateway, or paid service",
      uiSequence: [
        "B active before first A activation",
        "A selected while its real v1 Gateway response is held",
        "A to B through the visible profile selector",
        "B to A through the visible profile selector",
      ],
      ordering: {
        aSelectedWithOldHeldOrdinal,
        bVisibleWithOldAHeldOrdinal,
        aReactivatedWithNewResponseOrdinal,
        newAVisibleOrdinal,
        oldReleaseOrdinal,
        oldDeliveredOrdinal,
        newInventoryVisibleBeforeOldResponseRelease: newAVisibleOrdinal < oldReleaseOrdinal,
        capturedOldResponseDeliveredAfterRelease: oldReleaseOrdinal < oldDeliveredOrdinal,
      },
      profiles: {
        aProfileIdSha256: shortHash(profileA.id),
        aBearerFingerprint: shortHash(profileA.accessToken),
        bProfileIdSha256: shortHash(profileB.id),
        bBearerFingerprint: shortHash(profileB.accessToken),
        distinctProfileIds: profileA.id !== profileB.id,
        distinctBearerCredentials: profileA.accessToken !== profileB.accessToken,
      },
      mobileProfileBootstraps: {
        a: profileABootstrap,
        b: profileBBootstrap,
      },
      oldA: {
        request: held.request,
        upstreamResponse: held.response,
        deliveredResponse: oldDeliveredProof,
        deliveredRequest: oldDeliveredRequestProof,
        sameCapturedResponseTuple:
          held.response.status === oldDeliveredProof.status &&
          held.response.statusText === oldDeliveredProof.statusText &&
          held.response.bodySha256 === oldDeliveredProof.bodySha256 &&
          JSON.stringify(held.response.contractHeaders) === JSON.stringify(oldDeliveredProof.contractHeaders),
        v1Label: SERVER_A_LABEL,
      },
      newA: {
        request: newARequestProof,
        response: newAResponseProof,
        visibleBeforeOldRelease: true,
        v2Label: SERVER_A_NEW_LABEL,
      },
      b: {
        response: bResponseProof,
        request: bRequestProof,
        visibleWhileOldAHeld: true,
        serverStoreByteIdenticalAfterAba: true,
        persistedProfileAndCredentialUnchanged: true,
      },
      aFixtureMutation: mutationProof,
      aReadRequestCount: aReadRequests.length,
      aReadRequests,
      turnStartCount,
      noLiveModelConfigured: true,
      milestones,
    };
    await context.writeArtifactJson("server-editor-profile-switch-activation-aba-smoke.json", result);
    return result;
  } catch (error) {
    await captureMaskedScreenshot(
      context,
      page,
      "server-editor-profile-switch-activation-aba-smoke-failure.png",
    ).catch(() => {});
    const activeProfileId = await page.evaluate(({ key }) => {
      try {
        const id = JSON.parse(localStorage.getItem(key) ?? "null")?.activeId;
        return typeof id === "string" ? id : null;
      } catch {
        return null;
      }
    }, { key: PROFILE_INDEX_KEY }).catch(() => null);
    await context.writeArtifactJson("server-editor-profile-switch-activation-aba-smoke-failure.json", {
      retentionReason:
        "Failure evidence for the independent real Mobile profile activation ABA smoke; no response body, token, Cookie, or raw Authorization header is retained.",
      phase,
      route: safeUrl(page.url())?.pathname ?? null,
      activeProfileIdSha256: activeProfileId ? shortHash(activeProfileId) : null,
      oldResponseCaptured: Boolean(oldResponseCapture),
      oldResponseHoldReached: Boolean(oldResponseCapture) && !oldHandlerDone,
      oldResponseFailureName: oldResponseFailure?.name ?? null,
      oldResponse: oldResponseCapture,
      oldResponseHandlerFinished: oldHandlerDone,
      aReadRequestCount: aReadRequests.length,
      aReactivationRequestObserved: aReadRequests.length > 1,
      failureClassification:
        oldResponseCapture && aReadRequests.length === 1
          ? "stopped-before-independent-a-reactivation-read"
          : "harness-setup-or-assertion-failure",
      productConclusion: "not-inferred-from-harness-failure-alone",
      aReadRequests,
      milestones,
      errorName: error?.name ?? "Error",
    }).catch(() => {});
    throw error;
  } finally {
    releaseOldResponse.resolve();
    if (oldRouteEntered) {
      const oldRouteSettled = await waitFor(
        () => oldHandlerDone ? true : null,
        5_000,
        "the old A route handler must settle during smoke cleanup",
        25,
        context.abortSignal,
      ).then(() => true, () => false);
      if (!oldRouteSettled) {
        await context.writeArtifactJson("server-editor-profile-switch-activation-aba-smoke-cleanup.json", {
          status: "FAIL_OLD_ROUTE_HANDLER_DID_NOT_SETTLE",
          phase,
          oldResponseCaptured: Boolean(oldResponseCapture),
          aReadRequestCount: aReadRequests.length,
          ownedCleanupBoundary:
            "The run-owned Browser.close will dispose this page-scoped route and any handler that remains unsettled after the bounded 5-second release wait.",
        }).catch(() => {});
      }
    }
  }
}

async function verifyProductionMobileMount(context, gateway, role) {
  const mobileEntryUrl = new URL(`${MOBILE_MOUNT}/`, gateway.baseUrl).href;
  let responseStatus = null;
  try {
    const response = await fetch(mobileEntryUrl, {
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(10_000),
    });
    responseStatus = response.status;
    await response.body?.cancel();
    assert.equal(responseStatus, 200,
      `Gateway ${role} must serve the caller-pinned Mobile archive at production /mobile/`);
    return mobileEntryUrl;
  } catch (error) {
    await context.writeArtifactJson("server-editor-profile-cas-mobile-setup-failure.json", {
      phase: "production-mobile-mount-preflight",
      gatewayRole: role,
      expectedMount: `${MOBILE_MOUNT}/`,
      observedPath: new URL(mobileEntryUrl).pathname,
      responseStatus,
      browserPageCount: 0,
      storedProfileCount: 0,
      bootstrapRequestCount: 0,
      errorName: error?.name ?? "Error",
      conclusion: "Mobile mount setup failure; no profile connection or ABA behavior was exercised.",
    }).catch(() => {});
    throw error;
  }
}

async function connectAuthenticatedMobileProfile(context, page, gateway, {
  role,
  expectedServerId,
  mobileEntryUrl,
  observedServerRequests,
}) {
  const expectedPageOrigin = mobileEntryUrl
    ? new URL(mobileEntryUrl).origin
    : new URL(page.url()).origin;
  const diagnostic = {
    phase: mobileEntryUrl ? "navigate-to-production-mobile-mount" : "open-direct-connection",
    gatewayRole: role,
    expectedMount: `${MOBILE_MOUNT}/`,
    bootstrapRequestCount: 0,
    bootstrapStatuses: [],
    requestInitialServers: false,
    pairingTokenMatched: false,
    responsePayloadObserved: false,
  };
  const serverReadBaseline = observedServerRequests.filter((row) =>
    row.gatewayRole === role && row.method === "GET" && row.pathname === "/api/servers").length;
  const onRequest = (request) => {
    const url = safeUrl(request.url());
    if (request.method() !== "POST" || url?.origin !== gateway.baseUrl || url.pathname !== "/api/mobile/session") return;
    diagnostic.bootstrapRequestCount += 1;
    try {
      const body = request.postDataJSON();
      diagnostic.requestInitialServers = body?.requestInitialServers === true;
      diagnostic.pairingTokenMatched = body?.token === gateway.authToken;
    } catch {}
  };
  const onResponse = (response) => {
    if (isMobileSessionBootstrapResponse(response, gateway)) diagnostic.bootstrapStatuses.push(response.status());
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  try {
    if (mobileEntryUrl) {
      await page.goto(mobileEntryUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    }
    diagnostic.phase = "wait-for-real-mobile-direct-connection";
    const directConnection = await uniqueVisibleTestId(page, "welcome-direct-connection", 20_000);
    await directConnection.click();
    await (await uniqueVisibleTestId(page, "gateway-endpoint")).fill(gateway.baseUrl);
    if (gateway.authToken.length > 0) context.registerSecret(gateway.authToken);
    await (await uniqueVisibleTestId(page, "gateway-token")).fill(gateway.authToken);

    diagnostic.phase = "submit-authenticated-mobile-bootstrap";
    const bootstrapResponsePromise = page.waitForResponse(
      (response) => isMobileSessionBootstrapResponse(response, gateway),
      { timeout: 20_000 },
    );
    const connectButton = await uniqueVisibleTestId(page, "gateway-connect");
    await Promise.all([
      bootstrapResponsePromise,
      connectButton.click(),
    ]);
    const bootstrapResponse = await bootstrapResponsePromise;
    assert.equal(bootstrapResponse.status(), 200,
      `Gateway ${role} must return a successful real Mobile session bootstrap`);
    const payload = await bootstrapResponse.json();
    diagnostic.responsePayloadObserved = true;
    if (typeof payload?.accessToken === "string" && payload.accessToken.length > 0) context.registerSecret(payload.accessToken);
    if (typeof payload?.rpcToken === "string" && payload.rpcToken.length > 0) context.registerSecret(payload.rpcToken);
    assert.equal(diagnostic.bootstrapRequestCount, 1,
      `Mobile ${role} connection must make one POST /api/mobile/session`);
    assert.equal(diagnostic.requestInitialServers, true,
      `Mobile ${role} bootstrap must request the inline initial server inventory`);
    assert.equal(diagnostic.pairingTokenMatched, true,
      `Mobile ${role} bootstrap must submit its owned Gateway pairing token`);
    assert.equal(payload?.capabilities?.mobileInitialServersV1, true,
      `Gateway ${role} must advertise the initial server bootstrap capability`);
    assert.equal(payload?.initialServers?.version, 1,
      `Gateway ${role} must return the versioned initial server inventory`);
    const initialServerIds = serverIds(payload.initialServers);
    assert.deepEqual(initialServerIds, [expectedServerId],
      `Gateway ${role} bootstrap inventory must contain its one owned server`);

    diagnostic.phase = "wait-for-real-profile-persistence-and-route";
    const profile = await waitFor(async () => {
      try {
        return await readProfile(page, gateway.baseUrl);
      } catch {
        return null;
      }
    }, 20_000, `Mobile ${role} profile persisted after session bootstrap`, 50, context.abortSignal);
    registerProfileSecrets(context, profile);
    await waitForStoredActiveProfile(page, profile.id);
    await page.waitForURL((url) => {
      try {
        return mobileProfileIdFromHomeRoute(url.href) === profile.id;
      } catch {
        return false;
      }
    }, { timeout: 20_000 });
    await uniqueVisibleTestId(page, "new-workspace", 20_000);
    const routeProfileId = mobileProfileIdFromHomeRoute(page.url());
    assert.equal(routeProfileId, profile.id,
      `Mobile ${role} must route to the profile created by this bootstrap`);
    assert.equal(new URL(page.url()).origin, expectedPageOrigin,
      `Mobile ${role} connection must remain in the current same-origin Browser profile store`);
    assert.equal(profile.accessToken, payload.accessToken,
      `Mobile ${role} must persist the access token returned by the real bootstrap`);
    assert.equal(profile.rpcToken, payload.rpcToken,
      `Mobile ${role} must persist the RPC token returned by the real bootstrap`);
    return {
      profile,
      bootstrapEvidence: {
        gatewayRole: role,
        requestCount: diagnostic.bootstrapRequestCount,
        responseStatuses: [...diagnostic.bootstrapStatuses],
        requestInitialServers: diagnostic.requestInitialServers,
        pairingTokenMatched: diagnostic.pairingTokenMatched,
        mobileInitialServersV1: payload.capabilities.mobileInitialServersV1,
        initialServersVersion: payload.initialServers.version,
        initialServerIds,
        connectStageServerReadCount: observedServerRequests.filter((row) =>
          row.gatewayRole === role && row.method === "GET" && row.pathname === "/api/servers").length - serverReadBaseline,
        expectedServerId,
        activeProfileMatches: true,
        routeProfileMatches: true,
        sameOriginPageProfileStore: true,
        accessTokenMatchesBootstrap: true,
        rpcTokenMatchesBootstrap: true,
        profileIdSha256: shortHash(profile.id),
        accessTokenFingerprint: shortHash(profile.accessToken),
        rpcTokenFingerprint: shortHash(profile.rpcToken),
        inventorySource: "real POST /api/mobile/session response.initialServers; the test does not issue or wait for a separate connect-stage GET",
      },
    };
  } catch (error) {
    await captureMaskedScreenshot(context, page,
      `server-editor-profile-cas-mobile-${role.toLowerCase()}-setup-failure.png`).catch(() => {});
    const profileCount = await page.evaluate(({ key }) => {
      try {
        const index = JSON.parse(localStorage.getItem(key) ?? "null");
        const profiles = Array.isArray(index) ? index : index?.profiles;
        return Array.isArray(profiles) ? profiles.length : 0;
      } catch {
        return null;
      }
    }, { key: PROFILE_INDEX_KEY }).catch(() => null);
    await context.writeArtifactJson("server-editor-profile-cas-mobile-setup-failure.json", {
      phase: diagnostic.phase,
      gatewayRole: role,
      expectedMount: `${MOBILE_MOUNT}/`,
      route: safeUrl(page.url())?.pathname ?? null,
      pageClosed: page.isClosed(),
      pageCount: page.context().pages().length,
      storedProfileCount: profileCount,
      bootstrapRequestCount: diagnostic.bootstrapRequestCount,
      bootstrapStatuses: diagnostic.bootstrapStatuses,
      requestInitialServers: diagnostic.requestInitialServers,
      pairingTokenMatched: diagnostic.pairingTokenMatched,
      responsePayloadObserved: diagnostic.responsePayloadObserved,
      connectStageServerReadCount: observedServerRequests.filter((row) =>
        row.gatewayRole === role && row.method === "GET" && row.pathname === "/api/servers").length - serverReadBaseline,
      errorName: error?.name ?? "Error",
      conclusion: "Mobile bootstrap/setup failure; no profile-switch ABA behavior was exercised.",
    }).catch(() => {});
    throw error;
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
  }
}

function isMobileSessionBootstrapResponse(response, gateway) {
  const url = safeUrl(response.url());
  return Boolean(
    url &&
      url.origin === gateway.baseUrl &&
      url.pathname === "/api/mobile/session" &&
      response.request().method() === "POST",
  );
}

function mobileProfileIdFromHomeRoute(rawUrl) {
  const url = new URL(rawUrl);
  assert.ok(url.pathname.startsWith(`${MOBILE_MOUNT}/h/`), "the active profile must remain on the production Mobile mount");
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  assert.equal(segments[0], "mobile");
  assert.equal(segments[1], "h");
  assert.ok(segments[2], "the production Mobile home route must expose its profile id");
  return segments[2];
}

async function openSettingsHome(context, page) {
  let htmlLanguage = null;
  let settingsLabel = null;
  let settingsOverviewVisibleCount = 0;
  let homeAnchorVisibleCount = 0;
  let homeSettingsVisibleCount = 0;
  try {
    htmlLanguage = await page.locator("html").getAttribute("lang");
    const settingsOverview = visibleTestId(page, "diagnostics-settings");
    settingsOverviewVisibleCount = await settingsOverview.count();
    assert.ok(settingsOverviewVisibleCount <= 1,
      "the Settings overview must expose at most one visible diagnostics row");
    if (settingsOverviewVisibleCount === 1) return;

    const homeAnchor = visibleTestId(page, "new-workspace");
    homeAnchorVisibleCount = await homeAnchor.count();
    assert.equal(homeAnchorVisibleCount, 1,
      "open Settings from the unique Home dock only");
    const normalizedLanguage = (htmlLanguage ?? "").toLowerCase();
    settingsLabel = normalizedLanguage.startsWith("zh")
      ? "设置"
      : normalizedLanguage.startsWith("en")
        ? "Settings"
        : null;
    assert.ok(settingsLabel, `unsupported Mobile UI language for Settings navigation: ${htmlLanguage}`);

    // The Home Pressable exposes this accessible label but declares no role in source.
    const settingsButton = page.getByLabel(settingsLabel, { exact: true }).and(page.locator(":visible"));
    homeSettingsVisibleCount = await settingsButton.count();
    assert.equal(homeSettingsVisibleCount, 1,
      `Home must expose exactly one visible ${settingsLabel} control`);
    await settingsButton.click();
    await uniqueVisibleTestId(page, "diagnostics-settings", 15_000);
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
        htmlLanguage,
        settingsLabel,
        settingsOverviewVisibleCount,
        homeAnchorVisibleCount,
        homeSettingsVisibleCount,
        route: safeUrl(page.url())?.pathname ?? null,
        errorName: error?.name ?? "Error",
      },
    ).catch(() => {});
    throw error;
  }
}

async function openConnectionsSettings(context, page) {
  let connectionsScreenVisibleCount = 0;
  let settingsOverviewVisibleCount = 0;
  let manageConnectionsVisibleCount = 0;
  try {
    const connectionsScreen = visibleTestId(page, "settings-connections-screen");
    connectionsScreenVisibleCount = await connectionsScreen.count();
    assert.ok(connectionsScreenVisibleCount <= 1,
      "Mobile must expose at most one visible Connections settings screen");
    if (connectionsScreenVisibleCount === 1) return;

    settingsOverviewVisibleCount = await visibleTestId(page, "diagnostics-settings").count();
    if (settingsOverviewVisibleCount === 0) {
      await openSettingsHome(context, page);
      settingsOverviewVisibleCount = await visibleTestId(page, "diagnostics-settings").count();
    }
    assert.equal(settingsOverviewVisibleCount, 1,
      "the Connections settings entry must be reached from the visible Settings overview");

    const manageConnections = visibleTestId(page, "settings-manage-connections");
    await manageConnections.waitFor({ state: "visible", timeout: 15_000 });
    manageConnectionsVisibleCount = await manageConnections.count();
    assert.equal(manageConnectionsVisibleCount, 1,
      "Settings must expose exactly one visible Connections and devices control");
    await manageConnections.click();
    await uniqueVisibleTestId(page, "settings-connections-screen");
  } catch (error) {
    await captureMaskedScreenshot(
      context,
      page,
      "server-editor-profile-cas-connections-navigation-failure.png",
    ).catch(() => {});
    await context.writeArtifactJson(
      "server-editor-profile-cas-connections-navigation-failure.json",
      {
        retentionReason: "Setup failure evidence for the real Mobile Connections settings route before the profile CAS assertions.",
        htmlLanguage: await page.locator("html").getAttribute("lang").catch(() => null),
        route: safeUrl(page.url())?.pathname ?? null,
        settingsOverviewVisibleCount,
        manageConnectionsVisibleCount,
        connectionsScreenVisibleCount,
        errorName: error?.name ?? "Error",
      },
    ).catch(() => {});
    throw error;
  }
}

async function clickAddGateway(context, page) {
  await openConnectionsSettings(context, page);
  await (await uniqueVisibleTestId(page, "settings-add-gateway")).click();
}

async function switchToProfile(context, page, profile) {
  await openConnectionsSettings(context, page);
  await (
    await visibleLocalizedLabel(
      page,
      `切换到 ${profile.label}`,
      `Switch to ${profile.label}`,
    )
  ).click();
  await waitForStoredActiveProfile(page, profile.id);
  await uniqueVisibleTestId(page, "new-workspace", 15_000);
}

async function enterServerEditor(context, page, serverId) {
  await openConnectionsSettings(context, page);
  await (await uniqueVisibleTestId(page, `settings-host-${serverId}`, 15_000)).click();
  await uniqueVisibleTestId(page, "host-details-route", 15_000);
  await page.getByText("编辑 SSH 配置", { exact: true }).click();
  await uniqueVisibleTestId(page, "server-editor-route", 15_000);
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

async function visibleLocalizedLabel(page, chinese, english, scope = page) {
  const chineseLabel = scope.getByLabel(chinese, { exact: true }).and(page.locator(":visible"));
  const chineseCount = await chineseLabel.count();
  if (chineseCount > 0) {
    assert.equal(chineseCount, 1, `expected one visible localized accessible label for ${chinese}`);
    return chineseLabel;
  }
  const englishLabel = scope.getByLabel(english, { exact: true }).and(page.locator(":visible"));
  assert.equal(await englishLabel.count(), 1, `expected one visible localized accessible label for ${english}`);
  return englishLabel;
}

function visibleTestId(page, testId) {
  return page.locator(`[data-testid="${testId}"]:visible`);
}

async function uniqueVisibleTestId(page, testId, timeout = 15_000) {
  const locator = visibleTestId(page, testId);
  await locator.waitFor({ state: "visible", timeout });
  assert.equal(await locator.count(), 1, `expected exactly one visible test id: ${testId}`);
  return locator;
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

function serverLabels(payload) {
  assert.ok(payload && Array.isArray(payload.servers), "Gateway /api/servers response must contain a server list");
  return payload.servers.map((server) => server.label);
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

function requestEvidence(request) {
  const url = safeUrl(request.url());
  assert.ok(url, "the owned Gateway request URL must parse");
  const headers = request.headers();
  return {
    method: request.method(),
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
    bearerFingerprint: bearerFingerprint(headers),
    requestHeadersSha256: digestJson(headers),
  };
}

async function responseEvidence(response) {
  const [headers, body] = await Promise.all([
    Promise.resolve(response.headers()),
    response.body(),
  ]);
  const contractHeaderNames = ["cache-control", "content-type", "x-content-type-options"];
  const contractHeaders = Object.fromEntries(
    contractHeaderNames
      .filter((name) => typeof headers[name] === "string")
      .map((name) => [name, headers[name]]),
  );
  const payload = parseJsonBuffer(Buffer.from(body), "owned Gateway server inventory response");
  return {
    status: response.status(),
    statusText: await response.statusText(),
    contractHeaders,
    contractHeadersSha256: digestJson(contractHeaders),
    bodyBytes: body.length,
    bodySha256: sha256(body),
    serverIds: serverIds(payload),
    serverLabels: serverLabels(payload),
  };
}

function parseJsonBuffer(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function digestJson(value) {
  const normalized = value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value;
  return sha256(Buffer.from(JSON.stringify(normalized)));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
