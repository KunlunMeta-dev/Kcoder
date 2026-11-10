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
  restoreHistoricalMobileWebExportArchive,
} from "../harness/mobile-web-export-archive.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { appRoot, repoRoot, runE2E } from "../harness/run-context.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import {
  assertNoTaskCreation,
  assertDraftRouteIdentity,
  assertOwnedProjectRuntimeIdentity,
  createProjectContextFixture,
  gatewayServerConfiguration,
  observeMobileProjectRuntime,
  recordVerifiedUiPair,
  seedProjectContextTarget,
} from "./mobile-project-context-alignment.helpers.mjs";

const mode = process.env.KCODER_E2E_MOBILE_DRAWER_MODE;
assert.ok(mode === "baseline" || mode === "after" || mode === "after-archive",
  "set KCODER_E2E_MOBILE_DRAWER_MODE to baseline, after, or after-archive");
const isAfterMode = mode === "after" || mode === "after-archive";
const configuredBinary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
assert.ok(requireAbsolute(configuredBinary), "KCODER_E2E_KCODER_BIN must be absolute");
await Promise.all([
  access(configuredBinary),
  access(resolve(appRoot, "mobile/node_modules/expo/package.json")),
]);

await runE2E(import.meta.url, {
  testId: `mobile-drawer-project-context-${mode}`,
  tier: "manual-live",
  retainSuccessLogs: true,
  modelPolicy: "owned two-Gateway/four-Local-target real app-server project/workspace metadata and Mobile Web Drawer; no thread creation, Provider, paid model, or model turn",
}, async context => {
  const fixture = await createProjectContextFixture(context);
  const { mobile, sourceIdentity, buildInput } = await loadMobileBuildInput(context);
  const gatewayManifest = await buildGatewayMobileWebManifest(mobile.path, { expectedFiles: mobile.bundleFiles });
  await writeGatewayMobileWebManifest(mobile.path, gatewayManifest);
  const gatewayManifestSha256 = sha256(await readFile(resolve(mobile.path, "kcoder-mobile-web.json")));

  const targetsByGateway = Object.groupBy(fixture.deployments, item => item.id);
  const gateways = {};
  for (const gatewayId of ["gateway-alpha", "gateway-beta"]) {
    const targets = targetsByGateway[gatewayId];
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
      label: `mobile-drawer-${gatewayId}`,
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
    fixtureRpc.push(await seedProjectContextTarget(context, gateways[target.id], target));
  }

  const chromium = await startChromium(context, {
    label: "mobile-drawer-owned-chromium",
    noSandbox: true,
    startTimeoutMs: 60_000,
  });
  const browserContext = await chromium.browser.newContext({
    locale: "zh-CN",
    colorScheme: "dark",
    deviceScaleFactor: 2,
    viewport: { width: 390, height: 844 },
  });
  context.addCleanup("close mobile Drawer browser context", () => browserContext.close());
  const page = await browserContext.newPage();
  const aliases = Object.fromEntries([
    ["Shared", fixture.sharedPath],
    ...fixture.deployments.map(target => [target.targetAlias, target.defaultCwd]),
  ]);
  const verifiedProfiles = new Map();
  const observer = observeMobileProjectRuntime(page, {
    gateways,
    targets: fixture.deployments,
    pathLabels: aliases,
    verifiedProfiles,
  });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const screenshots = [];
  const matrix = [];
  const alphaProfile = await pairGatewayFromLogin(page, gateways["gateway-alpha"], gateways, observer);
  await observer.settlePairingObservations();
  const betaProfile = await addGatewayThroughSettings(page, gateways["gateway-alpha"], gateways["gateway-beta"], gateways, observer);
  assert.notEqual(alphaProfile.profileId, betaProfile.profileId,
    "two separately paired owned Gateways must create distinct Mobile profile IDs in the shared origin");
  await observer.settlePairingObservations();

  const uiOrigin = new URL(gateways["gateway-alpha"].baseUrl).origin;
  for (const profile of [alphaProfile, betaProfile]) {
    await switchToProfile(page, uiOrigin, profile.profileId);
    await waitForHomeRows(page, fixture.deployments.filter(target => target.id === profile.gatewayId));
  }
  await switchToProfile(page, uiOrigin, alphaProfile.profileId);

  for (const language of ["zh-CN", "en"]) {
    for (const theme of ["light", "dark"]) {
      await applyViewPreferences(page, { language, theme });
      await openDrawer(page, language);
      for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await visibleByTestId(page, "drawer-gateway-status").waitFor({ state: "visible", timeout: 15_000 });
        const screenshotName = `2026-10-15-mobile-drawer-alpha-${viewport.width}-${language}-${theme}.png`;
        await page.screenshot({ path: context.pathInArtifacts(screenshotName), animations: "disabled" });
        const screenshotBytes = await readFile(context.pathInArtifacts(screenshotName));
        screenshots.push({
          name: screenshotName,
          sha256: sha256(screenshotBytes),
          profileId: alphaProfile.profileId,
          language,
          theme,
          logicalViewport: viewport,
          deviceScaleFactor: 2,
        });
        matrix.push({ language, theme, logicalViewport: viewport, screenshot: screenshotName });
        if (isAfterMode) await assertCurrentDrawerContract(page, { fixture, profile: alphaProfile, gateways });
      }
    }
  }

  const drawerInteractions = isAfterMode
    ? await verifyDrawerInteractions(page, {
      fixture,
      profiles: [alphaProfile, betaProfile],
      uiOrigin,
      observer,
    })
    : null;

  await observer.settlePairingObservations();
  assertOwnedProjectRuntimeIdentity(observer, { gateways, targets: fixture.deployments, verifiedProfiles, uiOrigin });
  assertNoTaskCreation(observer, `Mobile Drawer ${mode} acceptance`);
  assert.deepEqual(pageErrors, [], "real Mobile Drawer acceptance must have no uncaught page errors");
  const harnessSourceFiles = await Promise.all([
    "apps/kcoder-studio/e2e/private/mobile-drawer-project-context-alignment.once.e2e.mjs",
    "apps/kcoder-studio/e2e/private/mobile-project-context-alignment.helpers.mjs",
    "apps/kcoder-studio/e2e/harness/mobile-web-export-archive.mjs",
  ].map(async path => ({ path, sha256: sha256(await readFile(resolve(repoRoot, path))) })));

  await context.writeArtifactJson("mobile-drawer-build-and-screenshot-provenance.json", {
    mode,
    inputKind: mobile.inputKind,
    historicalSourceHead: mobile.historicalSourceHead ?? null,
    currentHarnessHead: context.gitCommit,
    harnessSourceFiles,
    sourceIdentity,
    currentSourceIdentity: isAfterMode ? sourceIdentity : null,
    bundleSha256: mobile.bundleSha256,
    bundleFileCount: mobile.bundleFileCount,
    gatewayManifestSha256,
    archive: {
      path: mobile.archivePath ?? null,
      sha256: mobile.archiveSha256 ?? null,
      originalManifestSha256: mobile.originalManifestSha256 ?? buildInput.archive?.originalManifestSha256 ?? null,
      sourceIdentityFilePath: buildInput.sourceIdentityFilePath ?? null,
      sourceIdentityFileSha256: buildInput.sourceIdentityFileSha256 ?? null,
      originalRunManifestSha256: mobile.originalRunManifestSha256 ?? null,
    },
    fixture: {
      fixtureBoundary: "owned RunContext scratch; real runtime.projects.upsert_local followed by runtime.workspaces.list and runtime.worktrees.list through two owned Gateways and four Local targets",
      sharedPathAlias: "Shared",
      distinctDefaultRoots: new Set(fixture.deployments.map(target => target.defaultCwd)).size,
      sharedProjectKeyAcrossTargets: new Set(fixture.deployments.map(target => target.projectKey)).size === 1,
      gateways: Object.entries(gateways).map(([gatewayId, gateway]) => ({
        gatewayId,
        gatewayOrigin: new URL(gateway.baseUrl).origin,
        profileId: gatewayId === "gateway-alpha" ? alphaProfile.profileId : betaProfile.profileId,
        targets: fixture.deployments.filter(target => target.id === gatewayId).map(target => ({
          serverId: target.serverId,
          targetAlias: target.targetAlias,
          projectName: target.projectName,
          registeredRootAliases: ["Shared", target.targetAlias],
        })),
      })),
      registrations: fixtureRpc,
    },
    screenshotMatrix: matrix,
    screenshots,
    drawerInteractions,
    observedRpcCalls: observer.calls,
    pairingResponses: observer.pairingResponses,
    pageErrors,
    forbiddenThreadOrTurnStarts: observer.forbiddenStarts,
    limitations: [
      "Mobile Web only at logical widths 320 and 390, locales zh-CN and en, light and dark themes",
      "Owned isolated Chromium and Gateways; no public HMR, production Gateway, native phone, live user profile, Provider, or model turn",
      "Thread menu content is not exercised without creating a thread; the registered mobile-real-drawer-collapse-reload suite remains the existing thread action/fold lifecycle coverage",
    ],
  });

  return {
    mode,
    gatewayCount: 2,
    configuredLocalTargetCount: fixture.deployments.length,
    registeredWorkspaceRootsPerTarget: 2,
    screenshotCount: screenshots.length,
    screenshotMatrixCount: matrix.length,
    browserRuntimeCallCount: observer.calls.length,
    threadOrTurnStarts: observer.forbiddenStarts.length,
    pageErrors,
    bundleSha256: mobile.bundleSha256,
  };
});

async function loadMobileBuildInput(context) {
  const sourceRoots = [
    { name: "mobile", path: resolve(appRoot, "mobile"), destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: resolve(appRoot, "shared"), destination: "apps/kcoder-studio/shared" },
  ];
  if (mode === "baseline") {
    const sourceIdentityFilePath = resolve(repoRoot,
      "target/run/mobile-main-integration-20261015T060900Z/frozen-source-identity.json");
    const sourceIdentityBytes = await readFile(sourceIdentityFilePath);
    const sourceIdentityFileSha256 = sha256(sourceIdentityBytes);
    assert.equal(sourceIdentityFileSha256,
      "66d7babfa650ce2546af61a47cd5294005c82b7d1d3558f6c7029493faadd828",
      "historical baseline source identity file changed");
    const sourceIdentity = JSON.parse(sourceIdentityBytes.toString("utf8"));
    assert.equal(sourceIdentity.sourceTreeSha256, "fb9eb5b6e0097f54a2f2a80c32ddf689b5ef0ef1e492e6ef46e912c575a0245b",
      "historical baseline aggregate source identity differs from its expected pin");
    const archivePath = resolve(repoRoot,
      "target/test/apps/kcoder-studio/e2e/private/mobile-project-context-alignment.once.e2e.mjs/20261015-063206.645Z/artifacts/mobile-web-export-archive/bundle.archive.json");
    const mobile = await restoreHistoricalMobileWebExportArchive(context, {
      archivePath,
      expectedArchiveSha256: "d664d2cb55c9d5cab38aa4865624eda729877b1db4af0ff0f3c77c2a96e7714f",
      expectedHistoricalSourceIdentity: sourceIdentity,
      historicalSourceHead: "eb647ad9bdad12e6e2ec887881ecda4ac86e9355",
      expectedHistoricalRunManifestSha256: "1eff1e63b5b6d9b4f6ce83edf9fd8fe40212cd8ea221f3e1773ac57ffe03187c",
      outputName: "mobile-drawer-archived-baseline",
    });
    assert.equal(mobile.inputKind, "archived-baseline");
    assert.equal(mobile.bundleSha256, "fd88ea28611acd766e465e755a130861cf2e374a005c95326cc7d1d809600d53");
    assert.equal(mobile.originalManifestSha256, "5a8ccf43d7497f2df5b6f15504c59bafe01f90a3396531e9b92ddba771fec9c2");
    return {
      mobile,
      sourceIdentity,
      buildInput: { archive: mobile, sourceIdentityFilePath, sourceIdentityFileSha256 },
    };
  }

  const sourceIdentity = await inspectMobileWebExportSourceIdentity({ sourceRoots });
  const frozenIdentityFilePath = resolve(repoRoot,
    "target/run/mobile-drawer-alignment-20261015/ui-frozen-source-final.json");
  const frozenIdentityBytes = await readFile(frozenIdentityFilePath);
  const frozenSourceIdentity = JSON.parse(frozenIdentityBytes.toString("utf8"));
  assert.deepEqual(sourceIdentity, frozenSourceIdentity,
    "fresh After export source identity must exactly match the frozen Mobile/shared snapshot");
  assert.equal(sourceIdentity.sourceTreeSha256, process.env.KCODER_E2E_MOBILE_DRAWER_SOURCE_TREE_SHA256,
    "fresh Mobile build source tree must match the frozen root-reviewed hash pin");
  const sourceHashes = new Map(sourceIdentity.sourceRoots.map(root => [root.name, root.sha256]));
  assert.equal(sourceHashes.get("mobile"), process.env.KCODER_E2E_MOBILE_DRAWER_MOBILE_SOURCE_SHA256,
    "fresh Mobile build must match the frozen Mobile source hash pin");
  assert.equal(sourceHashes.get("studio-shared"), process.env.KCODER_E2E_MOBILE_DRAWER_SHARED_SOURCE_SHA256,
    "fresh Mobile build must match the frozen shared source hash pin");
  if (mode === "after-archive") {
    const archivePath = resolve(repoRoot,
      "target/test/apps/kcoder-studio/e2e/private/mobile-drawer-project-context-alignment.once.e2e.mjs/20261015-075833.086Z/artifacts/mobile-web-export-archive/bundle.archive.json");
    const mobile = await restoreMobileWebExportArchive(context, {
      archivePath,
      expectedArchiveSha256: "4c1a4dfb5f2d20b7e4c21db861ad20eadf11a752683bcfffeaf35c3dbc7d43a7",
      sourceIdentity,
      outputName: "mobile-drawer-verified-fresh-export-replay",
    });
    assert.equal(mobile.bundleSha256, "82415250af6896983c00cbd18b6ea3ef06dec1d827efb51470140d7182a2c9a6",
      "archive replay must use the exact bundle from the completed fresh export");
    return {
      mobile,
      sourceIdentity,
      buildInput: {
        archive: mobile,
        sourceIdentityFilePath: frozenIdentityFilePath,
        sourceIdentityFileSha256: sha256(frozenIdentityBytes),
        archiveReplayOf: "20261015-075833.086Z",
      },
    };
  }
  const mobile = await exportMobileWeb(context, {
    label: "mobile-drawer-fresh-mobile-web",
    outputName: "mobile-drawer-fresh-mobile-web",
    dependencyRoot: process.env.KCODER_E2E_MOBILE_DEPENDENCY_ROOT || undefined,
    timeoutMs: 10 * 60_000,
    overallTimeoutMs: 45 * 60_000,
    deployMount: true,
  });
  assert.equal(mobile.sourceTreeSha256, sourceIdentity.sourceTreeSha256,
    "fresh Mobile bundle source identity changed during export");
  const archive = await archiveMobileWebExport(context, { exportResult: mobile, sourceIdentity });
  return {
    mobile: { ...mobile, archivePath: archive.path, archiveSha256: archive.sha256, originalManifestSha256: archive.originalManifestSha256 },
    sourceIdentity,
    buildInput: {
      archive,
      sourceIdentityFilePath: frozenIdentityFilePath,
      sourceIdentityFileSha256: sha256(frozenIdentityBytes),
    },
  };
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
  const profileId = profileIdFromUrl(page.url());
  assert.ok(profileId, "successful Mobile Gateway pairing must navigate to a Home route with a profile ID");
  await visibleByTestId(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  const pair = recordVerifiedUiPair(observer, {
    gateways,
    responseMethod: response.request().method(),
    responseStatus: response.status(),
    responseUrl: response.url(),
    homeUrl: page.url(),
  });
  return { gatewayId: pair.gatewayId, profileId: pair.profileId, pairingStatus: pair.pairingStatus };
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

async function openDrawer(page, language) {
  const label = language === "zh-CN" ? "任务导航" : "Task navigation";
  await page.getByLabel(label).first().click();
  await visibleByTestId(page, "mobile-drawer").waitFor({ state: "visible", timeout: 15_000 });
}

async function waitForHomeRows(page, targets) {
  for (const target of targets) {
    await visibleByTestId(page, `home-workspace-row-${target.serverId}-0`).waitFor({ state: "visible", timeout: 30_000 });
    await visibleByTestId(page, `home-workspace-row-${target.serverId}-1`).waitFor({ state: "visible", timeout: 30_000 });
  }
}

async function assertCurrentDrawerContract(page, { fixture, profile, gateways }) {
  const currentProfileId = profileIdFromUrl(page.url());
  assert.equal(currentProfileId, profile.profileId,
    "Drawer workspace catalog must remain scoped to the paired Gateway profile route");
  const ownedTargets = fixture.deployments.filter(target => target.id === profile.gatewayId);
  assert.equal(ownedTargets.length, 2, "each paired profile must own exactly two fixture Local targets");
  assert.ok(gateways[profile.gatewayId], "the selected profile must map to its owned Gateway process");

  for (const target of ownedTargets) {
    const rows = await readDrawerRows(page, target.serverId);
    assert.equal(rows.length, 2,
      `${profile.gatewayId}/${target.serverId} must render exactly its two registered workspace roots`);
    for (const workspacePath of target.roots) {
      assert.equal(rows.filter(row => row.text.includes(workspacePath)).length, 1,
        `${target.targetAlias} must display the exact registered workspace path once: ${workspacePath}`);
    }
    assert.deepEqual(rows.map(row => row.index), [0, 1],
      `${target.targetAlias} workspace rows must retain stable group indexes`);
    assert.equal(await visibleByTestId(page, `drawer-target-status-${target.serverId}`).count(), 0,
      `${target.targetAlias} must not render a standalone target row when workspace rows exist`);
    assert.equal(await page.locator(`[data-testid^="drawer-project-${target.serverId}-"]:visible`).count(), 1,
      `${target.targetAlias} project name must be presented once above its two workspace rows`);
    const projectHeader = page.locator(`[data-testid^="drawer-project-${target.serverId}-"]:visible`);
    assert.ok((await projectHeader.innerText()).includes(target.projectName),
      `${target.targetAlias} project header must retain the registered project name`);

    for (const row of rows) {
      const { index } = row;
      const rowLocator = visibleByTestId(page, `drawer-workspace-row-${target.serverId}-${index}`);
      const toggle = visibleByTestId(page, index === 0
        ? `drawer-toggle-server-${target.serverId}`
        : `drawer-toggle-workspace-${target.serverId}-${index}`);
      const plus = visibleByTestId(page, `drawer-new-workspace-${target.serverId}-${index}`);
      const more = visibleByTestId(page, `drawer-workspace-actions-${target.serverId}-${index}`);
      assert.equal(await rowLocator.count(), 1);
      assert.equal(await plus.count(), 1, "each workspace row must own exactly one precise Plus action");
      assert.equal(await more.count(), 1, "each workspace row must own exactly one More action");
      assert.equal(await plus.isEnabled(), true, "registered workspace Plus must be enabled");
      assert.equal(await more.isEnabled(), true, "registered workspace More must be enabled");
      const projectBadgeCount = await rowLocator.evaluate(node => Array.from(node.querySelectorAll("*"))
        .filter(child => child.textContent?.trim() === "PROJECT").length);
      assert.equal(projectBadgeCount, 0, "workspace rows must not repeat the standalone PROJECT badge");
      assert.equal(await toggle.locator("svg").count(), 1, "workspace header toggle must contain only its Folder/GitBranch icon");
      assert.equal(await more.locator("svg").count(), 1, "workspace More control must contain one action icon");
      assert.equal(await plus.locator("svg").count(), 1, "workspace Plus control must contain one action icon");
      assert.equal(await rowLocator.locator("svg").count(), 3,
        "workspace header must contain only Folder/GitBranch, More, and Plus icons, with no right-arrow icon");
    }
  }
}

async function verifyDrawerInteractions(page, { fixture, profiles, uiOrigin, observer }) {
  const plusRoutes = [];
  const workspaceScopes = [];
  const profileByGateway = new Map(profiles.map(profile => [profile.gatewayId, profile]));

  for (const profile of profiles) {
    const targets = fixture.deployments.filter(target => target.id === profile.gatewayId);
    await returnToProfileHome(page, uiOrigin, profile.profileId, targets);
    await ensureDrawerOpen(page, "en");
    await verifyWorkspaceFold(page, targets[0]);

    for (const target of targets) {
      for (const cwd of target.roots) {
        await returnToProfileHome(page, uiOrigin, profile.profileId, targets);
        await ensureDrawerOpen(page, "en");
        const workspaceIndex = await findDrawerWorkspaceIndex(page, target.serverId, cwd);
        const plus = visibleByTestId(page, `drawer-new-workspace-${target.serverId}-${workspaceIndex}`);
        assert.equal(await plus.isEnabled(), true,
          `Plus must be enabled for ${profile.profileId}/${target.serverId}/${cwd}`);
        await plus.click();
        await page.waitForURL(url => url.pathname.replace(/\/$/, "") === "/mobile/new", { timeout: 20_000 });
        plusRoutes.push({
          ...assertDraftRouteIdentity(page, { profileId: profile.profileId, serverId: target.serverId, cwd }),
          gatewayId: target.id,
          targetAlias: target.targetAlias,
        });
        await visibleByTestId(page, "new-task-draft").waitFor({ state: "visible", timeout: 20_000 });
        assert.equal((await visibleByTestId(page, "new-task-draft-workspace").innerText()).trim(), cwd,
          "the draft must display the exact workspace selected by Plus");
        await visibleByTestId(page, "new-task-draft-target").waitFor({ state: "visible", timeout: 10_000 });
        await visibleByTestId(page, "message-input").waitFor({ state: "visible", timeout: 10_000 });
      }

      for (const cwd of target.roots) {
        await returnToProfileHome(page, uiOrigin, profile.profileId, targets);
        await ensureDrawerOpen(page, "en");
        const workspaceIndex = await findDrawerWorkspaceIndex(page, target.serverId, cwd);
        const menu = visibleByTestId(page, `workspace-actions-menu-${target.serverId}-${workspaceIndex}`);
        const trigger = visibleByTestId(page, `drawer-workspace-actions-${target.serverId}-${workspaceIndex}`);
        const refreshCountBefore = countObservedHistoryRefreshWrites(observer);
        await trigger.click();
        await menu.waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(await visibleByTestId(page, `refresh-history-${target.serverId}-${workspaceIndex}`).count(), 1,
          "More must offer the current workspace's single-scope refresh action");
        assert.equal(await visibleByTestId(page, `refresh-all-history-${target.serverId}-${workspaceIndex}`).count(), 0,
          "More must not offer a target-wide refresh action");
        const menuText = await menu.innerText();
        assert.ok(menuText.includes(cwd), "More must display the exact workspace path represented by its row");
        const otherWorkspacePath = target.roots.find(root => root !== cwd);
        assert.ok(otherWorkspacePath && !menuText.includes(otherWorkspacePath),
          "More must not include the sibling workspace path");
        await visibleByTestId(page, `refresh-history-${target.serverId}-${workspaceIndex}`).click();
        const dialog = visibleByTestId(page, "history-refresh-dialog");
        await dialog.waitFor({ state: "visible", timeout: 10_000 });
        const dialogText = await dialog.innerText();
        assert.ok(dialogText.includes(profile.profileId), "refresh confirmation must retain the exact paired profile ID");
        assert.ok(dialogText.includes(target.serverId), "refresh confirmation must retain the exact target server ID");
        assert.ok(dialogText.includes(cwd), "refresh confirmation must retain only the selected workspace path");
        assert.ok(!dialogText.includes(otherWorkspacePath), "refresh confirmation must exclude the sibling workspace path");
        assert.equal(await visibleByTestId(page, "history-refresh-start").isEnabled(), false,
          "an unconfirmed workspace refresh must remain disabled");
        await visibleByTestId(page, "history-refresh-close").click();
        await dialog.waitFor({ state: "hidden", timeout: 10_000 });
        assert.equal(countObservedHistoryRefreshWrites(observer), refreshCountBefore,
          "closing an unconfirmed workspace refresh must issue zero history refresh RPC writes");
        assert.equal(profileIdFromUrl(page.url()), profile.profileId,
          "closing More's confirmation must return to the same profile route");
        workspaceScopes.push({
          gatewayId: target.id,
          profileId: profile.profileId,
          serverId: target.serverId,
          targetAlias: target.targetAlias,
          cwd,
          refreshWritesBefore: refreshCountBefore,
          refreshWritesAfter: countObservedHistoryRefreshWrites(observer),
          unconfirmedCloseIssuedZeroWrites: true,
        });
      }
    }
  }

  assert.equal(plusRoutes.length, 8, "each profile/target/root combination must route its Plus action exactly");
  assert.equal(workspaceScopes.length, 8, "each profile/target/root More sheet must retain its exact workspace scope");
  for (const route of plusRoutes) assert.equal(route.profileId, profileByGateway.get(route.gatewayId).profileId);
  return {
    plusRoutes,
    workspaceScopes,
    fold: { gatewayId: profiles[0].gatewayId, serverId: fixture.deployments.find(target => target.id === profiles[0].gatewayId).serverId, interactionVerified: true },
    noThreadOrTurnCreated: true,
  };
}

async function returnToProfileHome(page, uiOrigin, profileId, targets) {
  if (profileIdFromUrl(page.url()) !== profileId || !new URL(page.url()).pathname.endsWith(`/h/${profileId}`)) {
    await page.goto(`${uiOrigin}/mobile/h/${encodeURIComponent(profileId)}`, { waitUntil: "domcontentloaded" });
  }
  await visibleByTestId(page, "new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await waitForHomeRows(page, targets);
  assert.equal(profileIdFromUrl(page.url()), profileId, "Home navigation must preserve the requested profile ID");
}

async function ensureDrawerOpen(page, language) {
  const drawer = visibleByTestId(page, "mobile-drawer");
  if (!(await drawer.isVisible().catch(() => false))) await openDrawer(page, language);
  await drawer.waitFor({ state: "visible", timeout: 15_000 });
}

async function findDrawerWorkspaceIndex(page, serverId, workspacePath) {
  const rows = await readDrawerRows(page, serverId);
  const match = rows.find(row => row.text.includes(workspacePath));
  assert.ok(match, `Drawer must contain the exact owned workspace path ${workspacePath}`);
  return match.index;
}

async function readDrawerRows(page, serverId) {
  return page.locator(`[data-testid^="drawer-workspace-row-${serverId}-"]:visible`).evaluateAll(nodes =>
    nodes.map(node => ({
      id: node.getAttribute("data-testid"),
      text: node.textContent ?? "",
    })).map(row => ({
      ...row,
      index: Number(row.id?.match(/-(\d+)$/)?.[1]),
    })));
}

async function verifyWorkspaceFold(page, target) {
  const rows = await readDrawerRows(page, target.serverId);
  assert.equal(rows.length, 2);
  const row = rows[0];
  const toggle = visibleByTestId(page, row.index === 0
    ? `drawer-toggle-server-${target.serverId}`
    : `drawer-toggle-workspace-${target.serverId}-${row.index}`);
  const initial = await toggle.getAttribute("aria-expanded");
  assert.ok(initial === "true" || initial === "false", "workspace fold control must expose its expanded state");
  await toggle.click();
  const expected = initial === "true" ? "false" : "true";
  await page.waitForFunction(({ testId, expected }) =>
    document.querySelector(`[data-testid="${testId}"]`)?.getAttribute("aria-expanded") === expected,
  { testId: await toggle.getAttribute("data-testid"), expected }, { timeout: 10_000 });
  await toggle.click();
  await page.waitForFunction(({ testId, initial }) =>
    document.querySelector(`[data-testid="${testId}"]`)?.getAttribute("aria-expanded") === initial,
  { testId: await toggle.getAttribute("data-testid"), initial }, { timeout: 10_000 });
}

function countObservedHistoryRefreshWrites(observer) {
  return observer.calls.filter(call => call.method === "thread/history/refresh").length;
}

function visibleByTestId(page, testId) {
  return page.getByTestId(testId);
}

function profileIdFromUrl(value) {
  const url = new URL(value);
  const id = url.pathname.match(/\/mobile\/h\/([^/]+)/)?.[1] ?? url.searchParams.get("profileId");
  if (!id) return null;
  try { return decodeURIComponent(id); } catch { return null; }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireAbsolute(value) {
  return typeof value === "string" && value.startsWith("/");
}
