import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import {
  archiveMobileWebExport,
  inspectMobileWebExportSourceIdentity,
  restoreMobileWebExportArchive,
} from "../harness/mobile-web-export-archive.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { appRoot, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import {
  assertDraftRouteIdentity,
  assertNoTaskCreation,
  assertOwnedProjectRuntimeIdentity,
  assertSharedWorkspaceRoutedAcrossProfiles,
  createProjectContextFixture,
  gatewayServerConfiguration,
  observeMobileProjectRuntime,
  recordVerifiedUiPair,
  seedProjectContextTarget,
} from "./mobile-project-context-alignment.helpers.mjs";

const expectedHead = process.env.KCODER_E2E_PROJECT_CONTEXT_EXPECTED_HEAD;
assert.match(expectedHead ?? "", /^[a-f0-9]{40}$/, "set KCODER_E2E_PROJECT_CONTEXT_EXPECTED_HEAD to the reviewed frozen source commit");
for (const [name, value] of [
  ["KCODER_E2E_PROJECT_CONTEXT_SOURCE_TREE_SHA256", process.env.KCODER_E2E_PROJECT_CONTEXT_SOURCE_TREE_SHA256],
  ["KCODER_E2E_PROJECT_CONTEXT_MOBILE_SOURCE_SHA256", process.env.KCODER_E2E_PROJECT_CONTEXT_MOBILE_SOURCE_SHA256],
  ["KCODER_E2E_PROJECT_CONTEXT_SHARED_SOURCE_SHA256", process.env.KCODER_E2E_PROJECT_CONTEXT_SHARED_SOURCE_SHA256],
]) assert.match(value ?? "", /^[a-f0-9]{64}$/, `set ${name} to the root-reviewed frozen source hash`);
const configuredBinary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
assert.ok(requireAbsolute(configuredBinary), "KCODER_E2E_KCODER_BIN must be absolute");
await Promise.all([
  access(configuredBinary),
  access(resolve(appRoot, "mobile/node_modules/expo/package.json")),
]);

await runE2E(import.meta.url, {
  testId: "mobile-project-context-alignment-real-multi-gateway",
  tier: "manual-live",
  retainSuccessLogs: true,
  modelPolicy: "owned two-Gateway/four-Local-target real app-server metadata and Mobile Web identity routing; no SSH, Desktop aggregation, thread creation, Provider, or model turn",
}, async context => {
  assert.equal(context.gitCommit, expectedHead, "run must use the reviewed frozen source commit");
  assert.equal(process.env.KCODER_E2E_PROJECT_CONTEXT_UI_READY, "1",
    "UNMET_PREREQUISITE: reviewed Mobile profile-add/switch and target-details selectors are not frozen");
  const fixture = await createProjectContextFixture(context);
  const sourceIdentity = await inspectMobileWebExportSourceIdentity({
    sourceRoots: [
      { name: "mobile", path: resolve(appRoot, "mobile"), destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: resolve(appRoot, "shared"), destination: "apps/kcoder-studio/shared" },
    ],
  });
  const sourceRootsByName = new Map(sourceIdentity.sourceRoots.map(root => [root.name, root.sha256]));
  assert.equal(sourceIdentity.sourceTreeSha256, process.env.KCODER_E2E_PROJECT_CONTEXT_SOURCE_TREE_SHA256,
    "Mobile/shared aggregate source tree must match the root-reviewed full hash pin");
  assert.equal(sourceRootsByName.get("mobile"), process.env.KCODER_E2E_PROJECT_CONTEXT_MOBILE_SOURCE_SHA256,
    "Mobile source root must match the root-reviewed hash pin");
  assert.equal(sourceRootsByName.get("studio-shared"), process.env.KCODER_E2E_PROJECT_CONTEXT_SHARED_SOURCE_SHA256,
    "studio-shared source root must match the root-reviewed hash pin");
  const archivePath = process.env.KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE;
  const archiveSha256 = process.env.KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE_SHA256;
  assert.equal(Boolean(archivePath), Boolean(archiveSha256),
    "archive reuse requires both KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE and its SHA-256 pin");
  let mobile;
  let archive;
  if (archivePath) {
    mobile = await restoreMobileWebExportArchive(context, {
      archivePath,
      expectedArchiveSha256: archiveSha256,
      sourceIdentity,
      outputName: "project-context-current-mobile-web-restored",
    });
    archive = {
      path: mobile.archivePath,
      sha256: mobile.archiveSha256,
      bundleSha256: mobile.bundleSha256,
      inputKind: mobile.inputKind,
    };
  } else {
    mobile = await exportMobileWeb(context, {
      label: "project-context-current-mobile-web",
      outputName: "project-context-current-mobile-web",
      dependencyRoot: process.env.KCODER_E2E_MOBILE_DEPENDENCY_ROOT || undefined,
      timeoutMs: 10 * 60_000,
      overallTimeoutMs: 45 * 60_000,
      deployMount: true,
    });
    archive = await archiveMobileWebExport(context, { exportResult: mobile, sourceIdentity });
  }
  assert.equal(mobile.sourceTreeSha256, sourceIdentity.sourceTreeSha256,
    "current Mobile bundle must match the inspected Mobile/shared source roots");
  const mobileManifest = await buildGatewayMobileWebManifest(mobile.path, { expectedFiles: mobile.bundleFiles });
  await writeGatewayMobileWebManifest(mobile.path, mobileManifest);
  const gatewayManifestSha256 = createHash("sha256")
    .update(await readFile(resolve(mobile.path, "kcoder-mobile-web.json")))
    .digest("hex");
  await context.writeArtifactJson("mobile-project-context-build-provenance.json", {
    sourceHead: context.gitCommit,
    sourceTreeSha256: mobile.sourceTreeSha256,
    sourceRoots: sourceIdentity.sourceRoots,
    mobileSourceSha256: sourceRootsByName.get("mobile"),
    sharedSourceSha256: sourceRootsByName.get("studio-shared"),
    bundleSha256: mobile.bundleSha256,
    bundleFileCount: mobile.bundleFileCount,
    dependencySourceTreeSha256: mobile.dependencySourceTreeSha256 ?? null,
    gatewayManifestSha256,
    exportArchive: {
      path: archive.path,
      sha256: archive.sha256,
      bundleSha256: archive.bundleSha256,
      inputKind: archive.inputKind ?? mobile.inputKind ?? "fresh-export",
    },
    inputKind: mobile.inputKind ?? "fresh-export",
  });

  const servers = Object.groupBy(fixture.deployments, item => item.id);
  const gateways = {};
  for (const gatewayId of ["gateway-alpha", "gateway-beta"]) {
    const targets = servers[gatewayId];
    const gatewayHome = context.pathInState(gatewayId, "home");
    const gatewayConfig = context.pathInState(gatewayId, "config");
    const gatewayData = context.pathInState(gatewayId, "data");
    const gatewayXdgConfig = resolve(gatewayHome, ".config");
    const gatewayCache = context.pathInState(gatewayId, "cache");
    await Promise.all([gatewayHome, gatewayConfig, gatewayData, gatewayXdgConfig, gatewayCache]
      .map(path => mkdir(path, { recursive: true, mode: 0o700 })));
    const serversStore = await context.writeStateJson(`${gatewayId}/servers-store.json`, gatewayServerConfiguration(targets));
    gateways[gatewayId] = await startGateway(context, {
      auth: true,
      label: `project-context-${gatewayId}`,
      serversStore,
      kcoderBin: configuredBinary,
      env: {
        KCODER_STUDIO_WEB_ROOT: "",
        KCODER_STUDIO_MOBILE_WEB_ROOT: mobile.path,
        ...(gatewayId === "gateway-beta" ? {
          KCODER_STUDIO_MOBILE_WEB_ORIGINS: new URL(gateways["gateway-alpha"].baseUrl).origin,
        } : {}),
        HOME: gatewayHome,
        USERPROFILE: gatewayHome,
        XDG_CONFIG_HOME: gatewayXdgConfig,
        XDG_DATA_HOME: gatewayData,
        XDG_CACHE_HOME: gatewayCache,
        KCODER_HOME: gatewayHome,
        KCODER_CONFIG_DIR: gatewayConfig,
      },
    });
  }

  const fixtureRpc = [];
  for (const target of fixture.deployments) {
    const result = await seedProjectContextTarget(context, gateways[target.id], target);
    fixtureRpc.push(result);
  }
  await context.writeArtifactJson("project-context-real-app-server-fixtures.json", {
    fixtureBoundary: "owned RunContext scratch; real runtime.projects.upsert_local followed by runtime.workspaces.list and runtime.worktrees.list through each owned Gateway",
    sharedAbsolutePathAcrossTargets: fixture.sharedPath,
    targetDefaultRootsAreDistinct: new Set(fixture.deployments.map(item => item.defaultCwd)).size === 4,
    allTargetsUseSameProjectKey: new Set(fixture.deployments.map(item => item.projectKey)).size === 1,
    gatewayStateIsolation: Object.entries(gateways).map(([gatewayId, gateway]) => ({
      gatewayId,
      gatewayOrigin: new URL(gateway.baseUrl).origin,
      mobileWebOrigins: gatewayId === "gateway-beta"
        ? [new URL(gateways["gateway-alpha"].baseUrl).origin]
        : [],
      home: context.pathInState(gatewayId, "home"),
      config: context.pathInState(gatewayId, "config"),
      data: context.pathInState(gatewayId, "data"),
      cache: context.pathInState(gatewayId, "cache"),
      targetsShareGatewayConfiguration: true,
    })),
    registrations: fixtureRpc,
  });

  await runMobileUiAcceptance({ context, fixture, gateways, mobile });
});

async function runMobileUiAcceptance({ context, fixture, gateways, mobile }) {
  const chromium = await startChromium(context, {
    label: "project-context-owned-chromium",
    noSandbox: true,
    startTimeoutMs: 60_000,
  });
  const observed = [];
  const forbiddenStarts = [];
  const screenshots = [];
  const pathLabels = Object.fromEntries([
    ["Shared", fixture.sharedPath],
    ...fixture.deployments.map(target => [target.targetAlias, target.defaultCwd]),
  ]);
  const matrix = [
    { language: "zh-CN", theme: "light" },
    { language: "zh-CN", theme: "dark" },
    { language: "en", theme: "light" },
    { language: "en", theme: "dark" },
  ];
  const browserContext = await chromium.browser.newContext({
    locale: "zh-CN",
    colorScheme: "dark",
    deviceScaleFactor: 2,
    viewport: { width: 390, height: 844 },
  });
  context.addCleanup("close project-context browser context", () => browserContext.close());
  const page = await browserContext.newPage();
  const uiOrigin = new URL(gateways["gateway-alpha"].baseUrl).origin;
  const verifiedProfiles = new Map();
  const observer = observeMobileProjectRuntime(page, {
    gateways,
    targets: fixture.deployments,
    pathLabels,
    verifiedProfiles,
  });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const artifactScreenshot = async (name, { fullPage = false } = {}) => {
    const path = context.pathInArtifacts(name);
    await page.screenshot({ path, fullPage, animations: "disabled" });
    screenshots.push(name);
    return path;
  };
  const matrixResults = [];
  const profileRuns = [];
  let alphaProfile;
  let betaProfile;
  let singleScope;
  let sharedCrossProfileRoutes = [];
  let progressStage = "pair-owned-gateways";
  let progressCheckpoint = 0;
  const persistProgressEvidence = async () => context.writeArtifactJson(
    `mobile-project-context-progress-evidence-${String(++progressCheckpoint).padStart(3, "0")}.json`, {
    checkpoint: progressCheckpoint,
    sourceHead: context.gitCommit,
    status: progressStage === "complete" ? "complete" : "partial",
    stage: progressStage,
    gatewayPairingCount: observer.pairingResponses.filter(response => response.status === 200).length,
    pairingResponses: observer.pairingResponses.slice(0, 4).map(response => ({
      gatewayId: response.gatewayId,
      sourceOrigin: response.sourceOrigin,
      pageOriginAtRequest: response.pageOriginAtRequest,
      destinationOrigin: response.destinationOrigin,
      status: response.status,
    })),
    pairingObservationErrors: observer.pairingObservationErrors.slice(0, 4),
    profilePairs: [alphaProfile, betaProfile].filter(Boolean).map(pair => ({
      gatewayId: pair.gatewayId,
      profileId: pair.profileId,
      pairingStatus: pair.pairingStatus,
    })),
    matrix: matrixResults,
    profileTargetRuns: profileRuns.map(summarizeProgressProfileTargetRun),
    singleScopeRefresh: singleScope ? summarizeProgressSingleScope(singleScope) : null,
    sharedWorkspaceCrossProfileRouteCount: sharedCrossProfileRoutes.length,
    rpcCallCount: observer.calls.length,
    observedRpcCalls: observer.calls.slice(0, 500).map(summarizeProgressCall),
    omittedRpcCallCount: Math.max(0, observer.calls.length - 500),
    identityErrorCount: observer.identityErrors.length,
    identityErrors: observer.identityErrors.slice(0, 100).map(summarizeProgressIdentityError),
    omittedIdentityErrorCount: Math.max(0, observer.identityErrors.length - 100),
    forbiddenStartCount: observer.forbiddenStarts.length,
    forbiddenThreadOrTurnStarts: observer.forbiddenStarts.slice(0, 100).map(summarizeProgressCall),
    omittedForbiddenStartCount: Math.max(0, observer.forbiddenStarts.length - 100),
    pageErrorCount: pageErrors.length,
    screenshots,
  });

  try {
    alphaProfile = await pairGatewayFromLogin(page, gateways["gateway-alpha"], gateways, observer);
    await observer.settlePairingObservations();
    progressStage = "alpha-gateway-paired";
    await persistProgressEvidence();
    betaProfile = await addGatewayThroughSettings(page, gateways["gateway-alpha"], gateways["gateway-beta"], gateways, observer);
    await observer.settlePairingObservations();
    assert.notEqual(alphaProfile.profileId, betaProfile.profileId,
      "two separately paired owned Gateways must create distinct Mobile profile IDs in the shared origin");
    progressStage = "owned-gateways-paired";
    await persistProgressEvidence();

    await switchToProfile(page, uiOrigin, alphaProfile.profileId);
    for (const combo of matrix) {
      progressStage = `alpha-one-home-menu-${combo.language}-${combo.theme}`;
    await applyViewPreferences(page, combo);
    await page.setViewportSize({ width: 390, height: 844 });
    await verifyHomeProjectRows(page, fixture.deployments.find(item => item.targetAlias === "Alpha-One"), {
      profileId: alphaProfile.profileId,
      expectedRootAliases: ["Shared", "Alpha-One"],
    });
    await assertNoHorizontalOverflow(page, `Alpha-One Home ${combo.language}/${combo.theme}`);
    await artifactScreenshot(`home-alpha-one-390-${combo.language}-${combo.theme}.png`);
    matrixResults.push({
      profile: "Alpha",
      target: "Alpha-One",
      language: combo.language,
      theme: combo.theme,
      logicalViewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      projectNamesAndPathsMatchFixture: true,
      noHorizontalOverflow: true,
    });

    await page.setViewportSize({ width: 320, height: 568 });
    await verifyHomeProjectRows(page, fixture.deployments.find(item => item.targetAlias === "Alpha-One"), {
      profileId: alphaProfile.profileId,
      expectedRootAliases: ["Shared", "Alpha-One"],
    });
    await assertNoHorizontalOverflow(page, `Alpha-One Home 320 ${combo.language}/${combo.theme}`);
    await artifactScreenshot(`home-alpha-one-320-${combo.language}-${combo.theme}.png`);
    matrixResults.push({
      profile: "Alpha",
      target: "Alpha-One",
      language: combo.language,
      theme: combo.theme,
      logicalViewport: { width: 320, height: 568 },
      deviceScaleFactor: 2,
      projectNamesAndPathsMatchFixture: true,
      noHorizontalOverflow: true,
    });

    await page.setViewportSize({ width: 320, height: 568 });
    const sharedIndex = await findWorkspaceIndex(page, "local-one", fixture.sharedPath);
    const foldResult = await verifyFoldStateIsolation(page, "local-one", sharedIndex);
    const menuResult = await verifyWorkspaceMenuLayout(page, {
      serverId: "local-one",
      workspaceIndex: sharedIndex,
      viewport: { width: 320, height: 568 },
      screenshotName: `menu-alpha-one-320-${combo.language}-${combo.theme}.png`,
      artifactScreenshot,
    });
    matrixResults.push({
      profile: "Alpha",
      target: "Alpha-One",
      language: combo.language,
      theme: combo.theme,
      logicalViewport: { width: 320, height: 568 },
      deviceScaleFactor: 2,
      rowMenuActionsInsideViewport: true,
      menuHasSingleScopeOnly: true,
      foldResult,
      menuResult,
    });
      await persistProgressEvidence();
    }

    // Exercise both profiles and all four actual Local target configurations using UI routes.
    for (const profile of [alphaProfile, betaProfile]) {
    await switchToProfile(page, uiOrigin, profile.profileId);
    await applyViewPreferences(page, { language: "zh-CN", theme: "dark" });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const target of fixture.deployments.filter(item => item.id === profile.gatewayId)) {
      const homeUrl = page.url();
      assert.equal(profileIdFromPageUrl(homeUrl), profile.profileId,
        `${target.targetAlias} project rows must be shown under the UI-paired profile`);
      progressStage = `plus-and-target-details-${target.targetAlias}`;
      const homeResult = await verifyHomeProjectRows(page, target, {
        profileId: profile.profileId,
        expectedRootAliases: ["Shared", target.targetAlias],
      });
      await assertNoHorizontalOverflow(page, `${target.targetAlias} Home 390 zh-CN/dark`);
      const rowRouteResults = [];
      for (const rootAlias of ["Shared", target.targetAlias]) {
        const workspacePath = rootAlias === "Shared" ? fixture.sharedPath : target.defaultCwd;
        const workspaceIndex = await findWorkspaceIndex(page, target.serverId, workspacePath);
        const route = await verifyPlusDraftRoute(page, {
          profileId: profile.profileId,
          serverId: target.serverId,
          cwd: workspacePath,
          workspaceIndex,
          homeUrl,
          target,
          observer,
        });
        rowRouteResults.push({ rootAlias, workspaceIndex, ...route });
      }
      const hostRefresh = await verifyTargetDetailsBatch(page, {
        uiOrigin,
        target,
        profileId: profile.profileId,
        roots: target.roots,
        observer,
        context,
        artifactScreenshot,
        capture: target.targetAlias === "Alpha-One" || target.targetAlias === "Beta-One",
      });
      profileRuns.push({
        gatewayId: profile.gatewayId,
        profileId: profile.profileId,
        targetAlias: target.targetAlias,
        serverId: target.serverId,
        homeUrl: safeRoute(homeUrl),
        projectRows: homeResult,
        plusRoutes: rowRouteResults,
        targetDetailsBatch: hostRefresh,
      });
      await persistProgressEvidence();
      await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
      await waitForHomeRows(page, target.serverId);
    }
    }

    const alphaOne = fixture.deployments.find(item => item.targetAlias === "Alpha-One");
    await switchToProfile(page, uiOrigin, alphaProfile.profileId);
    await applyViewPreferences(page, { language: "zh-CN", theme: "dark" });
    await page.setViewportSize({ width: 390, height: 844 });
    await verifyHomeProjectRows(page, alphaOne, {
      profileId: alphaProfile.profileId,
      expectedRootAliases: ["Shared", "Alpha-One"],
    });
    progressStage = "alpha-one-single-scope-refresh";
    singleScope = await verifySingleWorkspaceRefresh(page, {
    target: alphaOne,
    profileId: alphaProfile.profileId,
    workspacePath: fixture.sharedPath,
    observer,
    artifactScreenshot,
    context,
    });

    progressStage = "final-identity-and-no-task-assertions";
    await observer.settlePairingObservations();
    assertOwnedProjectRuntimeIdentity(observer, {
    gateways,
    targets: fixture.deployments,
    verifiedProfiles,
    uiOrigin,
  });
    sharedCrossProfileRoutes = assertSharedWorkspaceRoutedAcrossProfiles(observer);
    assertNoTaskCreation(observer, "project and workspace context acceptance");
    assert.deepEqual(pageErrors, [], "real Mobile UI acceptance must have no uncaught page errors");
    await context.writeArtifactJson("mobile-project-context-ui-acceptance.json", {
    boundary: "actual Mobile Web UI on Alpha Gateway origin, two authenticated owned Gateways, two configured Local targets per Gateway, and two real app-server-registered workspace roots per target",
    sourceHead: context.gitCommit,
    uiOrigin,
    profilePairs: [alphaProfile, betaProfile],
    fixture: {
      sharedPathAlias: "Shared",
      targetDefaultRootsAreDistinct: new Set(fixture.deployments.map(item => item.defaultCwd)).size === 4,
      registrations: fixture.deployments.map(target => ({
        gatewayId: target.id,
        serverId: target.serverId,
        targetAlias: target.targetAlias,
        projectKey: target.projectKey,
        projectName: target.projectName,
        roots: target.roots.map(path => pathAliasFor(path, pathLabels)),
      })),
    },
    matrix: matrixResults,
    profileTargetRuns: profileRuns,
    singleScopeRefresh: singleScope,
    sharedWorkspaceCrossProfileRoutes: sharedCrossProfileRoutes,
    observedRpcCalls: observer.calls,
    pairingResponses: observer.pairingResponses,
    identityErrors: observer.identityErrors,
    forbiddenThreadOrTurnStarts: observer.forbiddenStarts,
    pageErrors,
    screenshots,
    limitations: [
      "Mobile app-server runtime.projects/workspaces/worktrees metadata only; no Desktop runtime.tasks aggregation claim",
      "Local targets only; no SSH transport claim",
      "No thread/start, turn/start, provider call, paid model, or generated task content",
      "Cross-target path identity is tested as separate profile/server routing over the same owned absolute Shared path; shared disk metadata may be identical",
      "No production Gateway, real user project, native phone, or non-empty history behavior claim",
    ],
    });
    progressStage = "complete";
    return {
    profileCount: 2,
    gatewayCount: 2,
    configuredLocalTargetCount: fixture.deployments.length,
    registeredWorkspaceRootsPerTarget: 2,
    homeViewportLocaleThemeCombinations: 8,
    menuViewportLocaleThemeCombinations: 4,
    matrixObservationCount: matrixResults.length,
    profileTargetRunCount: profileRuns.length,
    singleScopeRefreshReady: singleScope.finalReadyReceiptCount === 1,
    targetWideBatchRuns: profileRuns.length,
    sharedWorkspaceSeparateProfileRouting: sharedCrossProfileRoutes.length >= 2,
    taskCreationObserved: observer.forbiddenStarts.length > 0,
    pageErrors,
    screenshots,
    mobileWebBundleSha256: mobile.bundleSha256,
    };
  } finally {
    if (progressStage !== "complete") {
      const currentUrl = safePageUrl(page.url());
      if (currentUrl && /^\/mobile\/(?:h\/[^/]+(?:\/.*)?|host-details|settings-connections|new)$/.test(currentUrl.pathname)) {
        try {
          const screenshotName = "mobile-project-context-ui-failure-state.png";
          await page.screenshot({ path: context.pathInArtifacts(screenshotName), animations: "disabled", timeout: 5_000 });
          screenshots.push(screenshotName);
        } catch {}
      }
    }
    await persistProgressEvidence();
  }
}

async function pairGatewayFromLogin(page, gateway, gateways, observer) {
  await page.goto(`${gateway.baseUrl}/login?returnTo=%2Fmobile%2F`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await page.locator('button[type="submit"]').click();
  await visibleByTestId(page, "welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  return pairGatewayFromWelcome(page, gateway, gateways, observer);
}

async function addGatewayThroughSettings(page, alphaGateway, betaGateway, gateways, observer) {
  const origin = new URL(alphaGateway.baseUrl).origin;
  await page.goto(`${origin}/mobile/settings-connections`, { waitUntil: "domcontentloaded" });
  await visibleByTestId(page, "settings-connections-screen").waitFor({ state: "visible", timeout: 30_000 });
  await visibleByTestId(page, "settings-add-gateway").click();
  await visibleByTestId(page, "welcome-direct-connection").waitFor({ state: "visible", timeout: 15_000 });
  return pairGatewayFromWelcome(page, betaGateway, gateways, observer);
}

async function pairGatewayFromWelcome(page, gateway, gateways, observer) {
  const responsePromise = page.waitForResponse(response => {
    let url;
    try { url = new URL(response.url()); } catch { return false; }
    return response.request().method() === "POST" && url.pathname === "/api/mobile/session" &&
      url.origin === new URL(gateway.baseUrl).origin && response.status() === 200;
  }, { timeout: 45_000 });
  await visibleByTestId(page, "welcome-direct-connection").click();
  await visibleByTestId(page, "gateway-endpoint").fill(gateway.baseUrl);
  await visibleByTestId(page, "gateway-token").fill(gateway.authToken);
  await visibleByTestId(page, "gateway-connect").click();
  const response = await responsePromise;
  await page.waitForURL(url => /\/mobile\/h\/[^/]+\/?$/.test(url.pathname), { timeout: 45_000 });
  const profileId = profileIdFromPageUrl(page.url());
  assert.ok(profileId, "successful Mobile Gateway pairing must navigate to a Home route with a profile ID");
  await visibleByTestId(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  const pair = recordVerifiedUiPair(observer, {
    gateways,
    responseMethod: response.request().method(),
    responseStatus: response.status(),
    responseUrl: response.url(),
    homeUrl: page.url(),
  });
  return { gatewayId: pair.gatewayId, profileId: pair.profileId, pairingStatus: pair.pairingStatus, responseOrigin: pair.responseOrigin };
}

async function switchToProfile(page, uiOrigin, profileId) {
  if (new URL(page.url()).pathname.endsWith(`/h/${profileId}`)) return page.url();
  await page.goto(`${uiOrigin}/mobile/settings-connections`, { waitUntil: "domcontentloaded" });
  await visibleByTestId(page, "settings-connections-screen").waitFor({ state: "visible", timeout: 30_000 });
  const row = visibleByTestId(page, `settings-gateway-${profileId}`);
  await row.waitFor({ state: "visible", timeout: 15_000 });
  if (await row.isEnabled()) await row.click();
  await page.waitForURL(url => url.pathname.endsWith(`/h/${profileId}`), { timeout: 30_000 });
  await visibleByTestId(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  return page.url();
}

async function applyViewPreferences(page, { language, theme }) {
  await page.evaluate(({ key, language, theme }) => {
    const previous = JSON.parse(localStorage.getItem(key) || "null") || {};
    localStorage.setItem(key, JSON.stringify({ ...previous, language, theme }));
  }, { key: "kcoder-studio:mobile-app-preferences:v1", language, theme });
  await page.emulateMedia({ colorScheme: theme });
  await page.reload({ waitUntil: "domcontentloaded" });
  await visibleByTestId(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(expected => document.documentElement.lang === expected, language, { timeout: 15_000 });
  await page.waitForFunction(expected => document.documentElement.style.colorScheme === expected, theme, { timeout: 15_000 });
}

async function verifyHomeProjectRows(page, target, { profileId, expectedRootAliases }) {
  assert.equal(profileIdFromPageUrl(page.url()), profileId, `${target.targetAlias} Home must stay under the selected profile`);
  await waitForHomeRows(page, target.serverId);
  const rowIds = await page.locator(`[data-testid^="home-workspace-row-${target.serverId}-"]:visible`).evaluateAll(nodes =>
    nodes.map(node => node.getAttribute("data-testid")));
  assert.equal(rowIds.length, expectedRootAliases.length,
    `${target.targetAlias} Home must render exactly the real registered roots plus no merged sibling target scopes`);
  const projectHeaders = page.locator(`[data-testid^="home-project-${target.serverId}-"]:visible`);
  assert.equal(await projectHeaders.count(), 1,
    `${target.targetAlias} two-root project must render one project heading`);
  assert.equal((await projectHeaders.first().innerText()).trim(), target.projectName,
    `${target.targetAlias} project heading must use its registered projectName`);

  const observedRows = [];
  for (let index = 0; index < rowIds.length; index += 1) {
    const testId = `home-workspace-row-${target.serverId}-${index}`;
    const row = visibleByTestId(page, testId);
    const text = await row.evaluate(node => node.textContent ?? "");
    const matchedRoot = expectedRootAliases.find(alias => {
      const expectedPath = alias === "Shared" ? target.roots.find(path => path.endsWith("/Shared")) : target.defaultCwd;
      return expectedPath && text.includes(expectedPath);
    });
    assert.ok(matchedRoot, `${target.targetAlias} row ${index} must display one exact registered root path`);
    const expectedLabel = matchedRoot === "Shared" ? "Shared" : target.targetAlias;
    assert.equal((await visibleByTestId(page, `home-workspace-name-${target.serverId}-${index}`).innerText()).trim(), expectedLabel,
      `${target.targetAlias} row label must match the actual workspace basename`);
    assert.ok(text.includes(target.serverId),
      `${target.targetAlias} duplicate Local target label must remain distinguishable by its real server ID`);
    const toggleId = index === 0 ? `toggle-server-${target.serverId}` : `toggle-workspace-${target.serverId}-${index}`;
    for (const controlId of [toggleId, `workspace-actions-${target.serverId}-${index}`, `new-workspace-${target.serverId}-${index}`]) {
      const accessibleName = await visibleByTestId(page, controlId).getAttribute("aria-label");
      assert.ok(accessibleName?.includes(target.serverId), `${controlId} accessible name must include the real server ID`);
    }
    observedRows.push({ index, testId, rootAlias: matchedRoot, expectedLabel, path: matchedRoot === "Shared" ? target.roots.find(path => path.endsWith("/Shared")) : target.defaultCwd });
  }
  assert.deepEqual(new Set(observedRows.map(row => row.rootAlias)), new Set(expectedRootAliases),
    `${target.targetAlias} project must expose both distinct registered roots`);
  return { projectName: target.projectName, rowCount: observedRows.length, rows: observedRows };
}

async function waitForHomeRows(page, serverId) {
  await visibleByTestId(page, `home-workspace-row-${serverId}-0`).waitFor({ state: "visible", timeout: 30_000 });
  await visibleByTestId(page, `home-workspace-row-${serverId}-1`).waitFor({ state: "visible", timeout: 30_000 });
}

async function findWorkspaceIndex(page, serverId, workspacePath) {
  const rows = await page.locator(`[data-testid^="home-workspace-row-${serverId}-"]:visible`).evaluateAll(nodes =>
    nodes.map(node => ({ id: node.getAttribute("data-testid"), text: node.textContent ?? "" })));
  const match = rows.find(row => row.text.includes(workspacePath));
  assert.ok(match?.id, `Home must display the exact owned workspace path ${workspacePath}`);
  const index = Number(match.id.split("-").at(-1));
  assert.ok(Number.isSafeInteger(index), "Home workspace row index must be numeric");
  return index;
}

async function verifyFoldStateIsolation(page, serverId, workspaceIndex) {
  const otherIndex = workspaceIndex === 0 ? 1 : 0;
  const toggleId = workspaceIndex === 0 ? `toggle-server-${serverId}` : `toggle-workspace-${serverId}-${workspaceIndex}`;
  const otherToggleId = otherIndex === 0 ? `toggle-server-${serverId}` : `toggle-workspace-${serverId}-${otherIndex}`;
  const toggle = visibleByTestId(page, toggleId);
  const otherToggle = visibleByTestId(page, otherToggleId);
  await waitEnabled(toggle, 15_000, `workspace fold state ${serverId}-${workspaceIndex}`);
  await waitEnabled(otherToggle, 15_000, `sibling workspace fold state ${serverId}-${otherIndex}`);
  const before = await toggle.getAttribute("aria-expanded");
  const otherBefore = await otherToggle.getAttribute("aria-expanded");
  assert.ok(before === "true" || before === "false");
  assert.ok(otherBefore === "true" || otherBefore === "false");
  await toggle.click();
  await page.waitForFunction(({ toggleId, expected }) => document.querySelector(`[data-testid="${toggleId}"]`)?.getAttribute("aria-expanded") === expected,
    { toggleId, expected: before === "true" ? "false" : "true" });
  assert.equal(await otherToggle.getAttribute("aria-expanded"), otherBefore,
    "collapsing one workspace must leave the sibling workspace fold state unchanged");
  await toggle.click();
  await page.waitForFunction(({ toggleId, expected }) => document.querySelector(`[data-testid="${toggleId}"]`)?.getAttribute("aria-expanded") === expected,
    { toggleId, expected: before });
  return { workspaceIndex, otherIndex, initialExpanded: before === "true", siblingUnchanged: true, restored: true };
}

async function verifyWorkspaceMenuLayout(page, { serverId, workspaceIndex, viewport, screenshotName, artifactScreenshot }) {
  const foldBefore = await visibleByTestId(page, workspaceIndex === 0 ? `toggle-server-${serverId}` : `toggle-workspace-${serverId}-${workspaceIndex}`).getAttribute("aria-expanded");
  const trigger = visibleByTestId(page, `workspace-actions-${serverId}-${workspaceIndex}`);
  await trigger.waitFor({ state: "visible", timeout: 15_000 });
  await waitEnabled(trigger, 30_000, `workspace history action for ${serverId}-${workspaceIndex}`);
  await trigger.click();
  const menu = visibleByTestId(page, `workspace-actions-menu-${serverId}-${workspaceIndex}`);
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  const single = visibleByTestId(page, `refresh-history-${serverId}-${workspaceIndex}`);
  await single.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await visibleByTestId(page, `refresh-all-history-${serverId}-${workspaceIndex}`).count(), 0,
    "workspace menu must expose only a single-workspace refresh; target-wide refresh lives in Host Details");
  for (const action of [single, visibleByTestId(page, `workspace-actions-close-${serverId}-${workspaceIndex}`)]) {
    const box = await action.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
      "workspace menu actions must remain inside the logical viewport");
    assert.ok(box.height >= 44, "workspace menu actions must meet the 44 CSS-pixel touch target");
  }
  await assertNoHorizontalOverflow(page, "workspace actions sheet");
  await artifactScreenshot(screenshotName);
  await visibleByTestId(page, `workspace-actions-close-${serverId}-${workspaceIndex}`).click();
  await menu.waitFor({ state: "hidden", timeout: 10_000 });
  const foldAfter = await visibleByTestId(page, workspaceIndex === 0 ? `toggle-server-${serverId}` : `toggle-workspace-${serverId}-${workspaceIndex}`).getAttribute("aria-expanded");
  assert.equal(foldAfter, foldBefore, "opening and closing the workspace menu must preserve its fold state");
  return { singleScopeActionVisible: true, globalActionAbsent: true, actionsInsideViewport: true, noHorizontalOverflow: true, foldPreserved: true };
}

async function verifyPlusDraftRoute(page, { profileId, serverId, cwd, workspaceIndex, homeUrl, target, observer }) {
  const startsBefore = observer.forbiddenStarts.length;
  const matchingCatalogReads = () => observer.calls.filter(call =>
    call.profileId === profileId && call.serverId === serverId && call.targetAlias === target.targetAlias &&
    (call.method === "runtime.workspaces.list" || call.method === "runtime.worktrees.list") && call.response?.success === true);
  assert.ok(matchingCatalogReads().length > 0,
    `${target.targetAlias} must have a successful real workspace/worktree catalog RPC under the selected profile and server before opening its draft`);
  const plus = visibleByTestId(page, `new-workspace-${serverId}-${workspaceIndex}`);
  await waitEnabled(plus, 30_000, `workspace Plus for ${serverId}-${workspaceIndex}`);
  await plus.click();
  await page.waitForURL(url => url.pathname === "/mobile/new", { timeout: 20_000 });
  const route = assertDraftRouteIdentity(page, { profileId, serverId, cwd });
  const draft = visibleByTestId(page, "new-task-draft");
  await draft.waitFor({ state: "visible", timeout: 20_000 });
  const draftTarget = visibleByTestId(page, "new-task-draft-target");
  await draftTarget.waitFor({ state: "visible", timeout: 10_000 });
  assert.ok((await draftTarget.innerText()).includes(target.serverLabel),
    "the waiting draft must display the clicked Local target label; exact server identity is verified by its route and matching catalog RPC");
  const draftWorkspace = visibleByTestId(page, "new-task-draft-workspace");
  await draftWorkspace.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal((await draftWorkspace.innerText()).trim(), cwd,
    "the waiting draft must display the exact workspace selected by the row Plus action");
  await visibleByTestId(page, "message-input").waitFor({ state: "visible", timeout: 10_000 });
  assert.ok(matchingCatalogReads().length > 0,
    "the selected draft target must remain backed by successful real catalog RPC evidence");
  assert.equal(observer.forbiddenStarts.length, startsBefore, "workspace Plus must open a draft without starting a task");
  await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
  await waitForHomeRows(page, serverId);
  assert.equal(new URL(page.url()).pathname, new URL(homeUrl).pathname,
    "returning from the draft must restore the same selected profile Home route");
  return { route, taskStartCountUnchanged: true };
}

async function verifyTargetDetailsBatch(page, { uiOrigin, target, profileId, roots, observer, context, artifactScreenshot, capture }) {
  await page.goto(`${uiOrigin}/mobile/settings-connections`, { waitUntil: "domcontentloaded" });
  await visibleByTestId(page, "settings-connections-screen").waitFor({ state: "visible", timeout: 30_000 });
  const hostRow = visibleByTestId(page, `settings-host-${target.serverId}`);
  await hostRow.waitFor({ state: "visible", timeout: 15_000 });
  await hostRow.click();
  await visibleByTestId(page, "host-details-route").waitFor({ state: "visible", timeout: 20_000 });
  let route = new URL(page.url());
  assert.ok(route.pathname.endsWith("/host-details"));
  assert.equal(route.searchParams.get("profileId"), profileId, "Host Details must retain the selected Gateway profile ID");
  assert.equal(route.searchParams.get("serverId"), target.serverId, "Host Details must retain the selected target server ID");
  const refresh = visibleByTestId(page, "host-refresh-known-history");
  await refresh.waitFor({ state: "visible", timeout: 15_000 });
  await waitEnabled(refresh, 30_000, `known workspace catalog for ${target.targetAlias}`);
  if (capture) await artifactScreenshot(`host-details-${target.targetAlias}-390-zh-CN-dark.png`);

  const visibleDialog = visibleByTestId(page, "history-refresh-dialog");
  const initialRefreshCount = countAllRefreshCalls(observer);
  await refresh.click();
  await visibleDialog.waitFor({ state: "visible", timeout: 10_000 });
  const scopes = await readDialogWorkspaceScopes(page, roots);
  assert.equal(await visibleByTestId(page, "history-refresh-start").isEnabled(), false,
    "target-wide refresh must require explicit confirmation");
  if (capture) await artifactScreenshot(`known-workspaces-confirmation-${target.targetAlias}-390-zh-CN-dark.png`);
  await visibleByTestId(page, "history-refresh-close").click();
  await visibleDialog.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(countAllRefreshCalls(observer), initialRefreshCount,
    "closing an unconfirmed target-wide refresh must issue zero history refresh writes for every observed profile and target");

  await page.goto(`${uiOrigin}/mobile/settings-connections`, { waitUntil: "domcontentloaded" });
  await visibleByTestId(page, "settings-connections-screen").waitFor({ state: "visible", timeout: 30_000 });
  await visibleByTestId(page, `settings-host-${target.serverId}`).click();
  await visibleByTestId(page, "host-details-route").waitFor({ state: "visible", timeout: 20_000 });
  const refreshAgain = visibleByTestId(page, "host-refresh-known-history");
  await waitEnabled(refreshAgain, 30_000, `known workspace catalog for confirmed ${target.targetAlias} batch`);
  const callStart = observer.calls.length;
  await refreshAgain.click();
  await visibleDialog.waitFor({ state: "visible", timeout: 10_000 });
  const confirmedScopes = await readDialogWorkspaceScopes(page, roots);
  assert.deepEqual(new Set(confirmedScopes), new Set(scopes), "confirmed scope snapshot must match the canceled dialog snapshot");
  await visibleByTestId(page, "history-refresh-acknowledge").click();
  const startButton = visibleByTestId(page, "history-refresh-start");
  assert.equal(await startButton.isEnabled(), true, "explicit acknowledgment must enable the target-wide refresh");
  await startButton.click();
  const expectedAliases = roots.map(path => pathLabelsForTarget(path, target));
  const result = await awaitRefreshCompletion(observer, {
    target,
    profileId,
    expectedWorkspaceAliases: expectedAliases,
    callStart,
    expectedStartCount: roots.length,
    timeoutMs: 90_000,
    context,
  });
  const progress = visibleByTestId(page, "history-refresh-batch-progress");
  await progress.waitFor({ state: "visible", timeout: 15_000 });
  const progressText = await waitFor(async () => {
    const text = await progress.innerText();
    return /2\s*\/\s*2/.test(text) ? text : null;
  }, 30_000, `target-wide batch UI completion for ${target.targetAlias}`, 50, context.abortSignal);
  if (capture) await artifactScreenshot(`known-workspaces-ready-${target.targetAlias}-390-zh-CN-dark.png`);
  await visibleByTestId(page, "history-refresh-close").click();
  await visibleDialog.waitFor({ state: "hidden", timeout: 10_000 });
  route = new URL(page.url());
  assert.ok(route.pathname.endsWith("/host-details"), "closing completed refresh must return to the same target details screen");
  assert.equal(route.searchParams.get("profileId"), profileId);
  assert.equal(route.searchParams.get("serverId"), target.serverId);
  return {
    canceledWithoutRpcWrites: true,
    cancelDialogScopes: scopes,
    confirmedDialogScopes: confirmedScopes,
    startCount: result.starts.length,
    finalReadyReceiptCount: result.finalReady.length,
    historyRefreshCalls: result.calls.map(summarizeObservedRefresh),
    progressText,
    completedWorkspaces: roots.length,
    scopeSetExact: true,
  };
}

async function verifySingleWorkspaceRefresh(page, { target, profileId, workspacePath, observer, artifactScreenshot, context }) {
  const workspaceIndex = await findWorkspaceIndex(page, target.serverId, workspacePath);
  const menu = visibleByTestId(page, `workspace-actions-menu-${target.serverId}-${workspaceIndex}`);
  const before = countAllRefreshCalls(observer);
  const trigger = visibleByTestId(page, `workspace-actions-${target.serverId}-${workspaceIndex}`);
  await waitEnabled(trigger, 30_000, `single workspace action ${target.targetAlias}`);
  await trigger.click();
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  await visibleByTestId(page, `refresh-history-${target.serverId}-${workspaceIndex}`).click();
  const dialog = visibleByTestId(page, "history-refresh-dialog");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  assert.ok((await dialog.innerText()).includes(workspacePath), "single-scope dialog must show its exact selected workspace path");
  assert.equal(await visibleByTestId(page, "history-refresh-start").isEnabled(), false);
  await visibleByTestId(page, "history-refresh-close").click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(countAllRefreshCalls(observer), before,
    "closing an unconfirmed single-workspace refresh must issue zero history refresh writes for every observed profile and target");

  await trigger.click();
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  await visibleByTestId(page, `refresh-history-${target.serverId}-${workspaceIndex}`).click();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  if (target.targetAlias === "Alpha-One") await artifactScreenshot("single-workspace-confirmation-alpha-one-390-zh-CN-dark.png");
  const callStart = observer.calls.length;
  await visibleByTestId(page, "history-refresh-acknowledge").click();
  await visibleByTestId(page, "history-refresh-start").click();
  const alias = pathLabelsForTarget(workspacePath, target);
  const result = await awaitRefreshCompletion(observer, {
    target,
    profileId,
    expectedWorkspaceAliases: [alias],
    callStart,
    expectedStartCount: 1,
    timeoutMs: 60_000,
    context,
  });
  await visibleByTestId(page, "history-refresh-close").click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return {
    workspaceAlias: alias,
    exactTarget: target.targetAlias,
    unconfirmedCloseIssuedZeroWrites: true,
    startCount: result.starts.length,
    finalReadyReceiptCount: result.finalReady.length,
    calls: result.calls.map(summarizeObservedRefresh),
  };
}

async function readDialogWorkspaceScopes(page, expectedPaths) {
  const container = visibleByTestId(page, "history-refresh-workspaces");
  await container.waitFor({ state: "visible", timeout: 10_000 });
  const visibleItems = page.locator('[data-testid^="history-refresh-workspace-"]:visible');
  assert.equal(await visibleItems.count(), expectedPaths.length,
    "known-workspaces dialog must render exactly the expected number of scope rows");
  const values = await Promise.all(expectedPaths.map(async (_, index) => {
    const item = visibleByTestId(page, `history-refresh-workspace-${index}`);
    await item.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await item.count(), 1, `known-workspaces dialog item ${index} must be unique`);
    return item.innerText();
  }));
  const canonical = values.map(value => resolve(value.trim()));
  assert.deepEqual(new Set(canonical), new Set(expectedPaths.map(value => resolve(value))),
    "known-workspaces dialog must show exactly the target's registered canonical paths");
  return canonical;
}

async function awaitRefreshCompletion(observer, { target, profileId, expectedWorkspaceAliases, callStart, expectedStartCount, timeoutMs, context }) {
  const started = await waitFor(() => {
    const writes = observer.calls.slice(callStart).filter(call => call.method === "thread/history/refresh");
    assertHistoryWritesMatchTarget(writes, target, profileId, expectedWorkspaceAliases,
      `${target.targetAlias} refresh may only write the selected profile, target, and scope set`);
    const failedReceipt = writes.find(call => isRefreshFailureReceipt(call.response));
    if (failedReceipt) return persistRefreshFailureAndThrow(context, target, failedReceipt);
    const starts = writes.filter(call => call.params?.acknowledgeExternalWriters === true);
    if (starts.length > expectedStartCount) throw new Error(`${target.targetAlias} refresh issued too many acknowledged starts`);
    if (starts.length !== expectedStartCount) return null;
    const aliases = starts.map(call => call.workspace);
    assert.deepEqual(new Set(aliases), new Set(expectedWorkspaceAliases),
      `${target.targetAlias} refresh must start once per expected registered workspace`);
    return { calls: writes, starts };
  }, timeoutMs, `acknowledged refresh starts for ${target.targetAlias}`, 50, context?.abortSignal);
  const final = await waitFor(async () => {
    const writes = observer.calls.slice(callStart).filter(call => call.method === "thread/history/refresh");
    assertHistoryWritesMatchTarget(writes, target, profileId, expectedWorkspaceAliases,
      `${target.targetAlias} refresh may only write the selected profile, target, and scope set`);
    const failedReceipt = writes.find(call => isRefreshFailureReceipt(call.response));
    if (failedReceipt) return persistRefreshFailureAndThrow(context, target, failedReceipt);
    const finalReady = started.starts.map(start => writes.filter(call =>
      call.socketOrdinal === start.socketOrdinal && call.workspace === start.workspace && call.params?.cursorPresent === true &&
      call.response?.status === "ready" && call.response.issueCount === 0 && call.response.hasNextCursor === false));
    return finalReady.every(receipts => receipts.length === 1) ? { calls: writes, starts: started.starts, finalReady: finalReady.flat() } : null;
  }, timeoutMs, `final cursor-ready receipts for ${target.targetAlias}`, 50, context?.abortSignal);
  assert.equal(final.starts.length, expectedStartCount);
  assert.equal(final.finalReady.length, expectedStartCount);
  assert.ok(final.starts.every(call => call.response?.status === "building" && call.response.hasNextCursor === true),
    "history refresh start must report building; ready must come from its later cursor request");
  assert.ok(final.finalReady.every(call => call.response.issueCount === 0));
  return final;
}

function isRefreshFailureReceipt(response) {
  return response?.status === "incomplete" || response?.rpcError === true;
}

async function persistRefreshFailureAndThrow(context, target, call) {
  const safeAlias = target.targetAlias.replace(/[^A-Za-z0-9_-]/g, "-");
  const fileName = `history-refresh-diagnostic-${safeAlias}-${call.socketOrdinal}.json`;
  await context.writeArtifactJson(fileName, {
    sourceHead: context.gitCommit,
    target: {
      gatewayId: call.gatewayId,
      profileId: call.profileId,
      serverId: call.serverId,
      targetAlias: call.targetAlias,
      workspaceAlias: call.workspace,
      workspaceSource: call.workspaceSource,
      socketOrdinal: call.socketOrdinal,
    },
    action: call.params?.acknowledgeExternalWriters ? "start" : call.params?.cursorPresent ? "cursor" : "other",
    response: summarizeProgressResponse(call.response),
  });
  const status = call.response?.status ?? "rpc-error";
  throw new Error(`${target.targetAlias}/${call.workspace} history refresh returned ${status}; safe issue details saved to artifacts/${fileName}`);
}

function countAllRefreshCalls(observer) {
  return observer.calls.filter(call => call.method === "thread/history/refresh").length;
}

function assertHistoryWritesMatchTarget(writes, target, profileId, expectedWorkspaceAliases, message) {
  const allowedWorkspaces = new Set(expectedWorkspaceAliases);
  const unexpected = writes.filter(call => call.gatewayId !== target.id || call.profileId !== profileId ||
    call.serverId !== target.serverId || call.targetAlias !== target.targetAlias || !allowedWorkspaces.has(call.workspace));
  assert.deepEqual(unexpected.map(summarizeObservedRefresh), [], message);
}

function summarizeObservedRefresh(call) {
  return {
    gatewayId: call.gatewayId,
    profileId: call.profileId,
    targetAlias: call.targetAlias,
    serverId: call.serverId,
    workspace: call.workspace,
    workspaceSource: call.workspaceSource,
    socketOrdinal: call.socketOrdinal,
    action: call.params?.acknowledgeExternalWriters ? "start" : call.params?.cursorPresent ? "cursor" : call.params?.cancel ? "cancel" : "unknown",
    acknowledgeExternalWriters: call.params?.acknowledgeExternalWriters === true,
    cursorPresent: call.params?.cursorPresent === true,
    response: call.response,
  };
}

async function waitEnabled(locator, timeoutMs, label) {
  await waitFor(async () => await locator.isEnabled() ? true : null, timeoutMs, label, 50);
}

function assertNoHorizontalOverflow(page, label) {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))
    .then(metrics => assert.ok(metrics.scrollWidth <= metrics.innerWidth + 1, `${label} must not overflow horizontally: ${JSON.stringify(metrics)}`));
}

function pathLabelsForTarget(path, target) {
  const normalized = resolve(path);
  if (normalized === resolve(target.roots.find(root => root.endsWith("/Shared")))) return "Shared";
  if (normalized === resolve(target.defaultCwd)) return target.targetAlias;
  throw new Error(`${target.targetAlias} received an unrecognized owned workspace path`);
}

function pathAliasFor(path, pathLabels) {
  const normalized = resolve(path);
  const entry = Object.entries(pathLabels).find(([, candidate]) => resolve(candidate) === normalized);
  assert.ok(entry, "registered fixture path must have a known safe alias");
  return entry[0];
}

function summarizeProgressCall(call) {
  return {
    socketOrdinal: call.socketOrdinal,
    gatewayId: call.gatewayId,
    profileId: call.profileId,
    profileIdentitySource: call.profileIdentitySource,
    pageRouteProfileIdAtSend: call.pageRouteProfileIdAtSend,
    serverId: call.serverId,
    targetAlias: call.targetAlias,
    workspace: call.workspace,
    workspaceSource: call.workspaceSource,
    method: call.method,
    params: summarizeProgressParams(call.params),
    response: summarizeProgressResponse(call.response),
  };
}

function summarizeProgressIdentityError(error) {
  return {
    socketOrdinal: error.socketOrdinal,
    gatewayId: error.gatewayId ?? null,
    profileId: error.profileId ?? null,
    serverId: error.serverId ?? null,
    targetAlias: error.targetAlias ?? null,
    workspace: error.workspace ?? null,
    workspaceSource: error.workspaceSource ?? null,
    method: error.method ?? null,
    issues: Array.isArray(error.issues) ? error.issues.slice(0, 12) : [],
  };
}

function summarizeProgressParams(params) {
  if (!params || typeof params !== "object") return {};
  return {
    deviceId: typeof params.deviceId === "string" ? params.deviceId : null,
    acknowledgeExternalWriters: params.acknowledgeExternalWriters === true,
    cancel: params.cancel === true,
    cursorPresent: params.cursorPresent === true,
  };
}

function summarizeProgressResponse(response) {
  if (!response || typeof response !== "object") return null;
  if (Number.isInteger(response.errorCode)) return {
    rpcError: response.rpcError === true,
    errorCode: response.errorCode,
    errorMessage: typeof response.errorMessage === "string" ? response.errorMessage.slice(0, 480) : "",
    pathAliases: Array.isArray(response.pathAliases) ? response.pathAliases.slice(0, 8) : [],
    osErrorCode: Number.isInteger(response.osErrorCode) ? response.osErrorCode : null,
  };
  if (response.rpcError === true) return {
    rpcError: true,
    errorCode: Number.isInteger(response.errorCode) ? response.errorCode : null,
    errorMessage: typeof response.errorMessage === "string" ? response.errorMessage.slice(0, 480) : "",
    pathAliases: Array.isArray(response.pathAliases) ? response.pathAliases.slice(0, 8) : [],
    osErrorCode: Number.isInteger(response.osErrorCode) ? response.osErrorCode : null,
  };
  const summary = {};
  for (const key of ["success", "status", "issueCount", "hasNextCursor"]) {
    if (Object.hasOwn(response, key)) summary[key] = response[key];
  }
  if (Array.isArray(response.issues)) {
    summary.issues = response.issues.slice(0, 8).map(issue => ({
      issueCode: typeof issue.issueCode === "string" ? issue.issueCode : null,
      sessionIdPresent: issue.sessionIdPresent === true,
      message: typeof issue.message === "string" ? issue.message.slice(0, 480) : "",
      pathAliases: Array.isArray(issue.pathAliases) ? issue.pathAliases.slice(0, 8) : [],
      osErrorCode: Number.isInteger(issue.osErrorCode) ? issue.osErrorCode : null,
    }));
  }
  if (Array.isArray(response.items)) {
    summary.items = response.items.slice(0, 20).map(item => ({
      workspace: item.workspace ?? null,
      projectKey: item.projectKey ?? null,
      projectName: item.projectName ?? null,
      roots: Array.isArray(item.roots) ? item.roots.slice(0, 8) : [],
      workspaceKind: item.workspaceKind ?? null,
      path: item.path ?? null,
      state: item.state ?? null,
      repositoryName: item.repositoryName ?? null,
    }));
    summary.omittedItemCount = Math.max(0, response.items.length - 20);
  }
  return summary;
}

function summarizeProgressProfileTargetRun(run) {
  return {
    gatewayId: run.gatewayId,
    profileId: run.profileId,
    targetAlias: run.targetAlias,
    serverId: run.serverId,
    projectRows: {
      projectName: run.projectRows?.projectName ?? null,
      rowCount: run.projectRows?.rowCount ?? 0,
      rows: Array.isArray(run.projectRows?.rows) ? run.projectRows.rows.map(row => ({
        index: row.index,
        rootAlias: row.rootAlias,
        expectedLabel: row.expectedLabel,
      })) : [],
    },
    plusRoutes: Array.isArray(run.plusRoutes) ? run.plusRoutes.map(item => ({
      rootAlias: item.rootAlias,
      workspaceIndex: item.workspaceIndex,
      route: {
        pathname: item.route?.pathname ?? null,
        profileId: item.route?.profileId ?? null,
        serverId: item.route?.serverId ?? run.serverId,
      },
      taskStartCountUnchanged: item.taskStartCountUnchanged === true,
    })) : [],
    targetDetailsBatch: run.targetDetailsBatch ? {
      canceledWithoutRpcWrites: run.targetDetailsBatch.canceledWithoutRpcWrites === true,
      cancelScopeCount: run.targetDetailsBatch.cancelDialogScopes?.length ?? 0,
      confirmedScopeCount: run.targetDetailsBatch.confirmedDialogScopes?.length ?? 0,
      startCount: run.targetDetailsBatch.startCount ?? 0,
      finalReadyReceiptCount: run.targetDetailsBatch.finalReadyReceiptCount ?? 0,
      historyRefreshCalls: Array.isArray(run.targetDetailsBatch.historyRefreshCalls)
        ? run.targetDetailsBatch.historyRefreshCalls.slice(0, 32).map(summarizeProgressCall)
        : [],
      omittedHistoryRefreshCallCount: Math.max(0, (run.targetDetailsBatch.historyRefreshCalls?.length ?? 0) - 32),
      progressText: typeof run.targetDetailsBatch.progressText === "string"
        ? run.targetDetailsBatch.progressText.slice(0, 120)
        : null,
      completedWorkspaces: run.targetDetailsBatch.completedWorkspaces ?? 0,
      scopeSetExact: run.targetDetailsBatch.scopeSetExact === true,
    } : null,
  };
}

function summarizeProgressSingleScope(result) {
  return {
    workspaceAlias: result.workspaceAlias,
    exactTarget: result.exactTarget,
    unconfirmedCloseIssuedZeroWrites: result.unconfirmedCloseIssuedZeroWrites === true,
    startCount: result.startCount ?? 0,
    finalReadyReceiptCount: result.finalReadyReceiptCount ?? 0,
    calls: Array.isArray(result.calls) ? result.calls.slice(0, 16).map(summarizeProgressCall) : [],
    omittedCallCount: Math.max(0, (result.calls?.length ?? 0) - 16),
  };
}

function profileIdFromPageUrl(value) {
  const url = new URL(value);
  const route = url.pathname.match(/\/mobile\/h\/([^/]+)/);
  return route ? decodeURIComponent(route[1]) : url.searchParams.get("profileId");
}

function safeRoute(value) {
  const url = new URL(value);
  return { origin: url.origin, pathname: url.pathname, profileId: profileIdFromPageUrl(value) };
}

function safePageUrl(value) {
  try { return new URL(value); } catch { return null; }
}

function visibleByTestId(page, id) {
  return page.locator(`[data-testid="${id}"]:visible`);
}

function requireAbsolute(value) {
  return typeof value === "string" && value.length > 0 && resolve(value) === value;
}
