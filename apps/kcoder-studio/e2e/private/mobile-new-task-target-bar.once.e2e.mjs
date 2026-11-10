import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { copyFrozenMobileWeb } from "../harness/frozen-copy.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { appRoot, repoRoot, runE2E } from "../harness/run-context.mjs";
import { fingerprintRegularTree } from "../harness/settings-fingerprints.mjs";
import { inspectMobileWebExportSourceIdentity, archiveMobileWebExport, restoreMobileWebExportArchive } from "../harness/mobile-web-export-archive.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import {
  assertDraftRouteIdentity,
  assertNoTaskCreation,
  assertOwnedProjectRuntimeIdentity,
  createProjectContextFixture,
  gatewayServerConfiguration,
  observeMobileProjectRuntime,
  recordVerifiedUiPair,
  seedProjectContextTarget,
} from "./mobile-project-context-alignment.helpers.mjs";

process.umask(0o077);

const mode = process.env.KCODER_E2E_NEW_TASK_TARGET_BAR_MODE;
assert.ok(mode === "before" || mode === "after" || mode === "after-replay",
  "set KCODER_E2E_NEW_TASK_TARGET_BAR_MODE to before, after, or after-replay");
const oldRunId = "20261015-085131.570Z";
const oldBuildRoot = resolve(repoRoot,
  "target/test/apps/kcoder-studio/e2e/private/mobile-current-product-build.once.mjs", oldRunId);
const oldArtifacts = resolve(oldBuildRoot, "artifacts");
const oldMobileRoot = resolve(oldArtifacts, "mobile-web");
const oldExporterManifestPath = resolve(oldArtifacts, "mobile-web-export-settings-mobile-web-manifest.json");
const oldProvenancePath = resolve(oldArtifacts, "mobile-web-provenance.json");
const oldRunManifestPath = resolve(oldBuildRoot, "manifest.json");
const oldResultPath = resolve(oldArtifacts, "result.json");
const oldPins = {
  sourceHead: "051169f4a907aee16bc7f8a59a9661c3366060fd",
  sourceTreeSha256: "7ccd931ba26293b97845e45723b67982af68eb04bf5526ed443e819852b175ff",
  mobileSourceSha256: "bab1f04f2d9d2de085672cba56621a9e04b5f8e73584229acb5472fa5f135370",
  sharedSourceSha256: "bc9ffeb8986087cff5aa5eb77226193456bb8e9ec3b2eaf1dbd004cda7eba97e",
  bundleSha256: "2bcb641ba2e887bb77b818d831de31416bff661fd94a7169aa41fa68ab49bfab",
  exporterManifestSha256: "7a4e63c7ca7b36d71b92957a87badfec337e1dbc49edbeadb6f9b26968962ecc",
  gatewayManifestSha256: "e220ddfeee67380e5c3231c322b71fceb6bf37379051d838cbf234e4a2e73168",
  fullRetainedTreeSha256: "42986f03a33371d1d0603155e79574cac6cf183c708fe9cee78265b7b35ec5dd",
};

const configuredBinary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
assert.ok(configuredBinary.startsWith("/"), "KCODER_E2E_KCODER_BIN must be absolute");
await Promise.all([
  access(resolve(appRoot, "mobile/node_modules/expo/package.json")),
  access(configuredBinary),
]);

await runE2E(import.meta.url, {
  testId: `mobile-new-task-target-bar-${mode}`,
  tier: "manual-live",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 30_000,
  modelPolicy: "isolated owned Gateway metadata and Mobile Web Chromium draft navigation; no thread or turn creation, Provider, or model request",
}, async context => {
  const fixture = await createProjectContextFixture(context);
  const { mobile, sourceIdentity, inputProof } = mode === "before"
    ? await loadHistoricalBefore(context)
    : await loadFreshAfter(context);
  const gatewayManifest = await buildGatewayMobileWebManifest(mobile.path, { expectedFiles: mobile.bundleFiles });
  await writeGatewayMobileWebManifest(mobile.path, gatewayManifest);
  const gatewayManifestSha256 = sha256(await readFile(resolve(mobile.path, "kcoder-mobile-web.json")));

  const targetsByGateway = Object.groupBy(fixture.deployments, target => target.id);
  const gateways = {};
  for (const gatewayId of ["gateway-alpha", "gateway-beta"]) {
    const targets = targetsByGateway[gatewayId];
    const gatewayHome = context.pathInState(gatewayId, "home");
    const gatewayConfig = context.pathInState(gatewayId, "config");
    const gatewayData = context.pathInState(gatewayId, "data");
    const gatewayCache = context.pathInState(gatewayId, "cache");
    await Promise.all([gatewayHome, gatewayConfig, gatewayData, gatewayCache,
      resolve(gatewayHome, ".config")].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
    const serversStore = await context.writeStateJson(`${gatewayId}/servers-store.json`, gatewayServerConfiguration(targets));
    gateways[gatewayId] = await startGateway(context, {
      auth: true,
      label: `new-task-target-bar-${gatewayId}`,
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
        XDG_CONFIG_HOME: resolve(gatewayHome, ".config"),
        XDG_DATA_HOME: gatewayData,
        XDG_CACHE_HOME: gatewayCache,
        KCODER_HOME: gatewayHome,
        KCODER_CONFIG_DIR: gatewayConfig,
      },
    });
  }

  const registrations = [];
  for (const target of fixture.deployments)
    registrations.push(await seedProjectContextTarget(context, gateways[target.id], target));

  const chromium = await startChromium(context, {
    label: "new-task-target-bar-owned-chromium",
    noSandbox: true,
    startTimeoutMs: 60_000,
  });
  const browserContext = await chromium.browser.newContext({
    locale: "zh-CN",
    colorScheme: "light",
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  context.addCleanup("close only the owned NewTask target-bar browser context", () => browserContext.close());
  const page = await browserContext.newPage();
  const modelMetadataFixture = await installEmptyModelMetadataFixture(page);
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
  const consoleErrors = [];
  const routeDiagnostics = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });

  const alphaProfile = await pairGatewayFromLogin(page, browserContext, gateways["gateway-alpha"], gateways, observer, context);
  await addGatewayThroughSettings(page, gateways["gateway-alpha"], gateways["gateway-beta"], gateways, observer);
  const betaProfileId = profileIdFromUrl(page.url());
  assert.ok(betaProfileId && betaProfileId !== alphaProfile.profileId, "second owned Gateway must pair to a distinct Mobile profile");
  await waitForHomeRows(page, fixture.deployments.filter(target => target.id === "gateway-beta"));
  await page.goto(`${new URL(gateways["gateway-alpha"].baseUrl).origin}/mobile/h/${encodeURIComponent(alphaProfile.profileId)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  await waitForHomeRows(page, fixture.deployments.filter(target => target.id === "gateway-alpha"));

  const selectedTarget = fixture.deployments.find(target => target.id === "gateway-alpha" && target.serverId === "local-one");
  assert.ok(selectedTarget, "fixture must contain the owned Alpha/Local One workspace");
  const groupIndex = await findHomeWorkspaceIndex(page, selectedTarget);
  await page.getByTestId(`new-workspace-${selectedTarget.serverId}-${groupIndex}`).click();
  await page.waitForURL(url => url.pathname.replace(/\/$/, "") === "/mobile/new", { timeout: 20_000 });
  const workspacePlusRoute = assertDraftRouteIdentity(page, {
    profileId: alphaProfile.profileId,
    serverId: selectedTarget.serverId,
    cwd: selectedTarget.defaultCwd,
  });
  await page.getByTestId("new-task-draft").waitFor({ state: "visible", timeout: 20_000 });
  await waitForDraftOptionsReady(page, "zh-CN");
  await assertLegacyAdvancedFormAbsent(page);

  const screenshotName = mode === "before"
    ? "2026-10-15-new-task-target-context-390-zh-CN-light-before.png"
    : "2026-10-15-new-task-target-context-390-zh-CN-light-after.png";
  await page.screenshot({ path: context.pathInArtifacts(screenshotName), animations: "disabled" });
  const screenshotSha256 = sha256(await readFile(context.pathInArtifacts(screenshotName)));
  const homeOrigin = new URL(gateways["gateway-alpha"].baseUrl).origin;
  let afterInteractions = null;
  let layoutCases = [];
  const screenshotEvidence = [{
    name: screenshotName,
    logicalViewport: { width: 390, height: 844 },
    locale: "zh-CN",
    theme: "light",
    state: "normal",
  }];
  if (mode !== "before") {
    await assertDraftContextReady(page, { language: "zh-CN", expectedCwd: selectedTarget.defaultCwd, width: 390 });
    afterInteractions = await verifyDraftContextInteractions(page, {
      context,
      fixture,
      selectedTarget,
      observer,
      modelMetadataFixture,
      profileId: alphaProfile.profileId,
      permissionScreenshot: "2026-10-15-new-task-target-context-permissions-390-zh-CN-light-expanded.png",
    });
    screenshotEvidence.push({ name: afterInteractions.permissionPreview.screenshot, logicalViewport: { width: 390, height: 844 }, locale: "zh-CN", theme: "light", state: "permission-preview-expanded" });
    screenshotEvidence.push({ name: afterInteractions.expandedDraftScreenshot, logicalViewport: { width: 390, height: 844 }, locale: "zh-CN", theme: "light", state: "unsent-multiline-draft-expanded" });
  }
  await page.goto(`${homeOrigin}/mobile/h/${encodeURIComponent(alphaProfile.profileId)}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("new-workspace").click();
  await page.waitForURL(url => url.pathname.replace(/\/$/, "") === "/mobile/new", { timeout: 20_000 });
  await page.getByTestId("new-task-draft").waitFor({ state: "visible", timeout: 20_000 });
  await waitForDraftOptionsReady(page, "zh-CN");
  const globalNewRoute = routeSummary(page.url());
  const alphaTargets = fixture.deployments.filter(target => target.id === "gateway-alpha");
  await recordDraftDiagnostic(context, page, routeDiagnostics, "global-new-before-project-selection",
    alphaTargets.map(target => target.serverId));
  assert.equal(globalNewRoute.searchParams.get("profileId"), alphaProfile.profileId,
    "global New must stay under the active Gateway profile");
  if (mode !== "before") {
    const picker = page.getByTestId("draft-context-project");
    await picker.click();
    const pickerModal = page.getByTestId("draft-context-project-modal");
    await pickerModal.waitFor({ state: "visible", timeout: 15_000 });
    const pickerDiagnostic = await recordDraftDiagnostic(context, page, routeDiagnostics,
      "global-new-project-picker-open", alphaTargets.map(target => target.serverId));
    const expectedCandidates = alphaTargets
      .map(target => ({ serverId: target.serverId, path: target.defaultCwd }))
      .sort((left, right) => `${left.serverId}\0${left.path}`.localeCompare(`${right.serverId}\0${right.path}`));
    const actualCandidates = pickerDiagnostic.visibleProjectOptions
      .map(option => ({ serverId: option.serverId, path: option.path }))
      .sort((left, right) => `${left.serverId}\0${left.path}`.localeCompare(`${right.serverId}\0${right.path}`));
    assert.deepEqual(actualCandidates, expectedCandidates,
      "Global New must offer the configured workspace default for each current Gateway target without guessing one");
    const targetProject = page.getByTestId(draftProjectOptionTestId(selectedTarget.serverId, selectedTarget.defaultCwd));
    await targetProject.click();
    await pickerModal.waitFor({ state: "hidden", timeout: 15_000 });
    await recordDraftDiagnostic(context, page, routeDiagnostics, "global-new-after-explicit-project-choice",
      alphaTargets.map(target => target.serverId));
    await page.waitForFunction(expected => document.querySelector('[data-testid="draft-context-project"]')
      ?.getAttribute("aria-label")?.includes(expected), selectedTarget.defaultCwd, { timeout: 20_000 });
    await waitForDraftOptionsReady(page, "zh-CN");
    let globalNewReady;
    try {
      globalNewReady = await assertDraftContextReady(page, {
        language: "zh-CN", expectedCwd: selectedTarget.defaultCwd, width: 390,
      });
    } catch (error) {
      await recordDraftDiagnostic(context, page, routeDiagnostics, "global-new-explicit-project-not-ready",
        alphaTargets.map(target => target.serverId));
      throw error;
    }
    assert.equal(globalNewReady.workspaceStatusText, null,
      "the explicit project must finish loading before Global New is considered ready");
    await picker.click();
    await pickerModal.waitFor({ state: "visible", timeout: 15_000 });
    const selectedPickerDiagnostic = await recordDraftDiagnostic(context, page, routeDiagnostics,
      "global-new-selected-project-reopened", alphaTargets.map(target => target.serverId));
    assert.equal(selectedPickerDiagnostic.visibleProjectOptions
      .filter(option => option.testId === draftProjectOptionTestId(selectedTarget.serverId, selectedTarget.defaultCwd))
      .filter(option => option.checkIconCount === 1).length, 1,
    "the explicitly chosen server and workspace path must remain the selected project");
    await page.keyboard.press("Escape");
    await pickerModal.waitFor({ state: "hidden", timeout: 15_000 });
    layoutCases = await verifyDraftContextLayoutMatrix(page, {
      homeOrigin,
      profileId: alphaProfile.profileId,
      selectedTarget,
      alphaTargets: fixture.deployments.filter(target => target.id === "gateway-alpha"),
      context,
    });
    screenshotEvidence.push(...layoutCases.flatMap(item => item.screenshot ? [item.screenshot] : []));
    afterInteractions.globalNew = {
      profileId: globalNewRoute.searchParams.get("profileId"),
      serverId: globalNewRoute.searchParams.get("serverId"),
      selectedServerId: selectedTarget.serverId,
      selectedPath: selectedTarget.defaultCwd,
      projectCandidatesBeforeSelection: actualCandidates,
      cwdVisibleInProjectControl: true,
      permissionPreviewVisible: globalNewReady.permissionVisible,
      workspaceStatusText: globalNewReady.workspaceStatusText,
      routeAfterSelection: routeSummary(page.url()).toString(),
    };
  }

  await observer.settlePairingObservations();
  assertOwnedProjectRuntimeIdentity(observer, {
    gateways,
    targets: fixture.deployments,
    verifiedProfiles,
    uiOrigin: homeOrigin,
  });
  assertNoTaskCreation(observer, `NewTask target-bar ${mode} draft flow`);
  assert.deepEqual(pageErrors, [], "isolated Mobile Web acceptance must have no uncaught page errors");
  assert.deepEqual(consoleErrors, [], "isolated Mobile Web acceptance must have no browser console errors");

  await context.writeArtifactJson("mobile-new-task-target-bar-evidence.json", {
    mode,
    inputKind: mobile.inputKind,
    historicalSourceHead: inputProof.historicalSourceHead ?? null,
    currentHarnessHead: context.gitCommit,
    sourceIdentity,
    inputProof,
    bundleSha256: mobile.bundleSha256,
    bundleFileCount: mobile.bundleFileCount,
    gatewayManifestSha256,
    fixture: {
      boundary: "owned RunContext scratch; two owned Gateways and four isolated Local targets; project/workspace metadata seeded through real app-server RPC",
      registrations,
      profileIds: { alpha: alphaProfile.profileId, beta: betaProfileId },
      selectedWorkspace: { gatewayId: selectedTarget.id, serverId: selectedTarget.serverId, alias: selectedTarget.targetAlias, cwd: selectedTarget.defaultCwd },
    },
    entryRoutes: { workspacePlus: workspacePlusRoute, globalNew: globalNewRoute.toString() },
    routeDiagnostics,
    screenshots: await Promise.all(screenshotEvidence.map(async item => ({
      ...item,
      sha256: sha256(await readFile(context.pathInArtifacts(item.name))),
      deviceScaleFactor: 2,
    }))),
    afterInteractions,
    layoutCases,
    observedRpcCalls: observer.calls,
    modelMetadataFixture,
    forbiddenThreadOrTurnStarts: observer.forbiddenStarts,
    pageErrors,
    consoleErrors,
    limitations: mode === "before" ? [
      "This is the sealed historical UI Before captured from the old Mobile Web export; it predates the project/status and permission-preview controls.",
      "Mobile Web in an isolated Chromium and owned local Gateways only; no native phone, public HMR, personal session, Provider, or model turn.",
    ] : [
      "Permission choices are a read-only preview and remain disconnected; no real permission configuration change is claimed.",
      "Mobile Web in isolated Chromium at logical widths 320/390, zh-CN/en, light/dark; no native phone, public HMR, personal session, Provider, or model turn.",
      ...(mode === "after-replay" ? ["This acceptance replayed the exact SHA-pinned fresh-export archive; it did not rebuild the Mobile Web bundle."] : []),
    ],
  });
  return { mode, screenshotName, screenshotSha256, workspacePlusRoute, globalNewRoute: globalNewRoute.toString(),
    screenshots: screenshotEvidence.length, layoutCases: layoutCases.length, afterInteractions,
    rpcCalls: observer.calls.length, forbiddenStarts: observer.forbiddenStarts.length };
});

async function loadHistoricalBefore(context) {
  const [runManifestBytes, resultBytes, exporterManifestBytes, provenanceBytes, appManifestBytes] = await Promise.all([
    readFile(oldRunManifestPath), readFile(oldResultPath), readFile(oldExporterManifestPath),
    readFile(oldProvenancePath), readFile(resolve(oldMobileRoot, "kcoder-mobile-web.json")),
  ]);
  const runManifest = JSON.parse(runManifestBytes);
  const result = JSON.parse(resultBytes);
  const exporterManifest = JSON.parse(exporterManifestBytes);
  const provenance = JSON.parse(provenanceBytes);
  const appManifest = JSON.parse(appManifestBytes);
  assert.equal(runManifest.status, "passed");
  assert.equal(runManifest.gitCommit, oldPins.sourceHead);
  assert.ok(runManifest.cleanupSteps.every(step => step.status === "completed"), "sealed old build cleanup must be complete");
  assert.equal(result.status, "passed");
  assert.deepEqual(result.cleanupErrors, []);
  assert.equal(sha256(exporterManifestBytes), oldPins.exporterManifestSha256);
  assert.equal(exporterManifest.status, "complete");
  assert.equal(exporterManifest.sourceUnchanged, true);
  assert.equal(exporterManifest.snapshotCopyMatchesSource, true);
  assert.equal(exporterManifest.snapshotUnchangedDuringExport, true);
  assert.equal(exporterManifest.sourceTreeSha256, oldPins.sourceTreeSha256);
  assert.equal(exporterManifest.bundleSha256, oldPins.bundleSha256);
  assert.equal(exporterManifest.bundleFileCount, 49);
  assert.equal(provenance.sourceHead, oldPins.sourceHead);
  assert.equal(provenance.mobileSourceDigest, oldPins.mobileSourceSha256);
  assert.equal(provenance.sharedSourceDigest, oldPins.sharedSourceSha256);
  assert.equal(provenance.exporter.manifestSha256, oldPins.exporterManifestSha256);
  assert.equal(provenance.retainedBundle.fullRegularTreeSha256, oldPins.fullRetainedTreeSha256);
  assert.equal(provenance.retainedBundle.fullRegularTreeFileCount, 50);
  assert.equal(sha256(appManifestBytes), oldPins.gatewayManifestSha256);
  assert.equal(appManifest.files.length, 49);
  assert.deepEqual(appManifest.files.map(({ path, size, sha256: hash }) => ({ path, size, sha256: hash })), exporterManifest.bundleFiles);

  const sourceTree = await fingerprintRegularTree(oldMobileRoot);
  assert.equal(sourceTree.digest, oldPins.fullRetainedTreeSha256, "sealed historical Mobile Web output tree changed");
  const sourceRows = sourceTree.entries.filter(entry => entry.path !== "kcoder-mobile-web.json");
  assert.deepEqual(byLocalePath(sourceRows), exporterManifest.bundleFiles,
    "historical output resources differ from the pinned exporter table");
  const stagedRoot = context.pathInState("historical-mobile-web-bundle-input");
  await mkdir(stagedRoot, { recursive: false, mode: 0o700 });
  context.registerTemporaryDirectory("verified historical Mobile Web resource staging", stagedRoot);
  for (const entry of exporterManifest.bundleFiles) await copyPinnedResource(oldMobileRoot, stagedRoot, entry);
  const staged = await fingerprintRegularTree(stagedRoot);
  assert.deepEqual(byLocalePath(staged.entries), exporterManifest.bundleFiles,
    "staged historical bundle differs from the pinned exporter resource table");
  assert.deepEqual(await fingerprintRegularTree(oldMobileRoot), sourceTree,
    "sealed historical Mobile Web output changed while the owned staging copy was created");
  const copiedRoot = context.pathInState("historical-mobile-web-bundle");
  const copyProof = await copyFrozenMobileWeb({
    sourceRoot: stagedRoot,
    destination: copiedRoot,
    manifestPath: oldExporterManifestPath,
    expectedBundleSha256: oldPins.bundleSha256,
    expectedSourceTreeSha256: oldPins.sourceTreeSha256,
  });
  const sourceIdentity = {
    sourceHead: oldPins.sourceHead,
    sourceTreeSha256: oldPins.sourceTreeSha256,
    mobileSourceSha256: oldPins.mobileSourceSha256,
    sharedSourceSha256: oldPins.sharedSourceSha256,
  };
  return {
    mobile: { path: copiedRoot, inputKind: "sealed-historical-export-resources", ...copyProof, bundleFiles: exporterManifest.bundleFiles },
    sourceIdentity,
    inputProof: {
      historicalSourceHead: oldPins.sourceHead,
      originalRunManifestSha256: sha256(runManifestBytes),
      originalRunStatus: runManifest.status,
      originalRunCleanupSteps: runManifest.cleanupSteps.length,
      exporterManifestSha256: sha256(exporterManifestBytes),
      gatewayManifestSha256: sha256(appManifestBytes),
      retainedOutputTreeSha256: sourceTree.digest,
      originalBundleSha256: exporterManifest.bundleSha256,
      bundleFileCount: exporterManifest.bundleFileCount,
      copyStatus: copyProof.status,
    },
  };
}

async function loadFreshAfter(context) {
  const expected = {
    head: process.env.KCODER_E2E_NEW_TASK_TARGET_BAR_EXPECTED_HEAD,
    sourceTreeSha256: process.env.KCODER_E2E_NEW_TASK_TARGET_BAR_SOURCE_TREE_SHA256,
    mobileSourceSha256: process.env.KCODER_E2E_NEW_TASK_TARGET_BAR_MOBILE_SOURCE_SHA256,
    sharedSourceSha256: process.env.KCODER_E2E_NEW_TASK_TARGET_BAR_SHARED_SOURCE_SHA256,
  };
  assert.match(expected.head ?? "", /^[a-f0-9]{40}$/, "frozen After source HEAD pin is required");
  for (const [label, value] of Object.entries(expected).filter(([key]) => key !== "head"))
    assert.match(value ?? "", /^[a-f0-9]{64}$/, `${label} frozen source hash pin is required`);
  assert.equal(context.gitCommit, expected.head, "After run must use the frozen source HEAD");
  const sourceRoots = [
    { name: "mobile", path: resolve(appRoot, "mobile"), destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: resolve(appRoot, "shared"), destination: "apps/kcoder-studio/shared" },
  ];
  const sourceIdentity = await inspectMobileWebExportSourceIdentity({ sourceRoots });
  assert.equal(sourceIdentity.sourceTreeSha256, expected.sourceTreeSha256);
  const roots = new Map(sourceIdentity.sourceRoots.map(root => [root.name, root.sha256]));
  assert.equal(roots.get("mobile"), expected.mobileSourceSha256);
  assert.equal(roots.get("studio-shared"), expected.sharedSourceSha256);
  if (mode === "after-replay") {
    const archivePath = resolve(repoRoot,
      "target/test/apps/kcoder-studio/e2e/private/mobile-new-task-target-bar.once.e2e.mjs/20261015-101612.531Z/artifacts/mobile-web-export-archive/bundle.archive.json");
    const mobile = await restoreMobileWebExportArchive(context, {
      archivePath,
      expectedArchiveSha256: "8b850c0e036a94c0d4db826a6f6ededdb6332779ef06865a2da03b91f6f7b280",
      sourceIdentity,
      outputName: "new-task-target-context-pinned-after-replay",
    });
    assert.equal(mobile.bundleSha256, "228361224398dc75e7e69a4198a13389172e78054f6aa979f67af44d4c8ba672");
    assert.equal(mobile.originalManifestSha256, "eb10a9eac00274c259ddcdc38bb117d0cd3850d6cd80faa637a0686cdc230f2c");
    return {
      mobile,
      sourceIdentity,
      inputProof: {
        freshExport: false,
        archiveReplay: true,
        archivePath: mobile.archivePath,
        archiveSha256: mobile.archiveSha256,
        originalManifestSha256: mobile.originalManifestSha256,
        bundleSha256: mobile.bundleSha256,
        originalFreshExportRun: "20261015-101612.531Z",
      },
    };
  }
  const mobile = await exportMobileWeb(context, {
    mobileRoot: resolve(appRoot, "mobile"),
    sourceRoots,
    dependencyRoot: resolve(appRoot, "mobile/node_modules"),
    label: "new-task-target-bar-fresh-mobile-web",
    outputName: "new-task-target-bar-fresh-mobile-web",
    deployMount: true,
    timeoutMs: 10 * 60_000,
    overallTimeoutMs: 45 * 60_000,
  });
  assert.equal(mobile.sourceTreeSha256, sourceIdentity.sourceTreeSha256);
  const archive = await archiveMobileWebExport(context, { exportResult: mobile, sourceIdentity });
  return {
    mobile: { ...mobile, bundleFiles: mobile.bundleFiles, archivePath: archive.path, archiveSha256: archive.sha256 },
    sourceIdentity,
    inputProof: { freshExport: true, archivePath: archive.path, archiveSha256: archive.sha256, exporterManifestSha256: archive.originalManifestSha256 },
  };
}

async function copyPinnedResource(sourceRoot, destinationRoot, entry) {
  assert.ok(typeof entry.path === "string" && entry.path.length > 0);
  assert.ok(!entry.path.includes("\\") && !entry.path.includes("\0"));
  assert.ok(!entry.path.startsWith("/") && !entry.path.split("/").some(segment => !segment || segment === "." || segment === ".."));
  const source = resolve(sourceRoot, ...entry.path.split("/"));
  assert.ok(source.startsWith(`${sourceRoot}${sep}`), "pinned historical bundle path escaped its root");
  let current = sourceRoot;
  for (const segment of entry.path.split("/")) {
    current = resolve(current, segment);
    const info = await lstat(current);
    assert.equal(info.isSymbolicLink(), false, `sealed historical Mobile Web resource traverses a symlink: ${entry.path}`);
    if (current !== source) assert.ok(info.isDirectory(), `historical Mobile Web resource parent is not a directory: ${entry.path}`);
    else assert.ok(info.isFile(), `historical Mobile Web resource is not a regular file: ${entry.path}`);
  }
  const bytes = await readFile(source);
  assert.equal(bytes.length, entry.size, `historical resource size changed: ${entry.path}`);
  assert.equal(sha256(bytes), entry.sha256, `historical resource hash changed: ${entry.path}`);
  const destination = resolve(destinationRoot, ...entry.path.split("/"));
  assert.ok(destination.startsWith(`${destinationRoot}${sep}`), "staged historical bundle path escaped owned state");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
}

async function pairGatewayFromLogin(page, browserContext, gateway, gateways, observer, context) {
  const loginResponse = await page.goto(`${gateway.baseUrl}/login?returnTo=%2Fmobile%2F`, { waitUntil: "domcontentloaded" });
  assert.equal(loginResponse?.status(), 200, "owned Gateway login page must load locally");
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForURL(url => url.pathname === "/mobile/", { timeout: 15_000 }),
    page.locator("form button").click(),
  ]);
  const cookies = await browserContext.cookies(gateway.baseUrl);
  assert.ok(cookies.some(cookie => cookie.name === "kcoder_studio_session"), "private owned browser login must create its Gateway session cookie");
  for (const cookie of cookies) context.registerSecret(cookie.value);
  const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  context.registerSecret(cookieHeader);
  context.addCleanup(`logout only owned ${gateway.label ?? "Gateway"} browser session`, async () => {
    const response = await fetch(`${gateway.baseUrl}/logout`, {
      method: "POST",
      headers: { cookie: cookieHeader, accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 303, "owned Gateway browser session must be logged out before its browser context closes");
  });
  const profile = await pairGatewayFromWelcome(page, gateway, gateways, observer);
  return profile;
}

async function addGatewayThroughSettings(page, alphaGateway, betaGateway, gateways, observer) {
  const origin = new URL(alphaGateway.baseUrl).origin;
  await page.goto(`${origin}/mobile/settings-connections`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("settings-connections-screen").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("settings-add-gateway").click();
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 15_000 });
  return pairGatewayFromWelcome(page, betaGateway, gateways, observer);
}

async function pairGatewayFromWelcome(page, gateway, gateways, observer) {
  const responsePromise = page.waitForResponse(response => {
    let url;
    try { url = new URL(response.url()); } catch { return false; }
    return response.request().method() === "POST" && url.pathname === "/api/mobile/session" &&
      url.origin === new URL(gateway.baseUrl).origin && response.status() === 200;
  }, { timeout: 45_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  const response = await responsePromise;
  await page.waitForURL(url => /\/mobile\/h\/[^/]+\/?$/.test(url.pathname), { timeout: 45_000 });
  const pair = recordVerifiedUiPair(observer, {
    gateways,
    responseMethod: response.request().method(),
    responseStatus: response.status(),
    responseUrl: response.url(),
    homeUrl: page.url(),
  });
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  return { gatewayId: pair.gatewayId, profileId: pair.profileId, pairingStatus: pair.pairingStatus };
}

async function installEmptyModelMetadataFixture(page) {
  const fixture = { policy: "only runtime.models.list is answered with an empty owned metadata result; workspace/worktree RPC remains connected to the owned app-server", requests: [], responses: [] };
  await page.routeWebSocket("**/rpc*", routed => {
    let socketUrl;
    try { socketUrl = new URL(routed.url()); } catch { socketUrl = null; }
    const upstream = routed.connectToServer();
    routed.onMessage(raw => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { upstream.send(raw); return; }
      if (frame?.method === "runtime.models.list" && frame.id !== undefined) {
        const serverId = socketUrl?.searchParams.get("server") ?? null;
        fixture.requests.push({ serverId, requestId: String(frame.id), method: frame.method });
        routed.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { data: [] } }));
        fixture.responses.push({ serverId, requestId: String(frame.id), itemCount: 0, origin: "owned-page-model-metadata-fixture" });
        return;
      }
      upstream.send(raw);
    });
    upstream.onMessage(raw => routed.send(raw));
  });
  return fixture;
}

async function waitForDraftOptionsReady(page, language) {
  const loading = language === "zh-CN" ? "正在读取项目和模型选项…" : "Loading project and model options…";
  await page.waitForFunction(value => !document.body.innerText.includes(value), loading, { timeout: 20_000 });
}

function draftProjectOptionTestId(serverId, path) {
  return `draft-context-project-option-${encodeURIComponent(serverId)}-${encodeURIComponent(path)}`;
}

async function recordDraftDiagnostic(context, page, diagnostics, phase, knownServerIds) {
  const snapshot = await page.evaluate(serverIds => {
    const isVisible = node => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const nodeSnapshot = testId => {
      const node = document.querySelector(`[data-testid="${testId}"]`);
      if (!node) return null;
      return {
        visible: isVisible(node),
        label: node.getAttribute("aria-label"),
        text: (node.innerText ?? node.textContent ?? "").trim() || null,
        role: node.getAttribute("role"),
        disabled: node.getAttribute("aria-disabled") === "true" || node.hasAttribute("disabled"),
      };
    };
    const url = new URL(location.href);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|auth|secret|session|credential|cookie/i.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    const visibleProjectOptions = [...document.querySelectorAll('[data-testid^="draft-context-project-option-"]')]
      .filter(isVisible)
      .map(node => {
        const testId = node.getAttribute("data-testid") ?? "";
        const serverId = serverIds.find(value => testId.startsWith(`draft-context-project-option-${encodeURIComponent(value)}-`)) ?? null;
        return {
          testId,
          serverId,
          path: node.innerText?.split("·").at(-1)?.trim() ?? null,
          label: (node.innerText ?? node.textContent ?? "").trim(),
          checkIconCount: node.querySelectorAll("svg").length,
        };
      });
    const visibleServerOptionCount = [...document.querySelectorAll('[data-testid^="server-option-"]')].filter(isVisible).length;
    const visibleGatewayOptionCount = [...document.querySelectorAll('[data-testid^="gateway-option-"]')].filter(isVisible).length;
    const visibleTargetOptionCount = [...document.querySelectorAll('[data-testid^="target-option-"]')].filter(isVisible).length;
    return {
      url: url.toString(),
      viewport: { width: innerWidth, height: innerHeight },
      route: { pathname: url.pathname, profileId: url.searchParams.get("profileId"), serverId: url.searchParams.get("serverId") },
      project: nodeSnapshot("draft-context-project"),
      projectName: nodeSnapshot("draft-context-project-name"),
      status: nodeSnapshot("draft-context-status"),
      workspaceStatus: nodeSnapshot("new-task-draft-workspace-status"),
      model: nodeSnapshot("draft-model-selector"),
      permission: nodeSnapshot("draft-permission-preview-button"),
      permissionPreview: nodeSnapshot("draft-feature-preview-modal"),
      visibleProjectOptions,
      visibleProjectCandidateCount: visibleProjectOptions.length,
      visibleProjectCandidateTargetCount: new Set(visibleProjectOptions.map(option => option.serverId).filter(Boolean)).size,
      visibleProjectCandidateServerIds: [...new Set(visibleProjectOptions.map(option => option.serverId).filter(Boolean))].sort(),
      visibleServerOptionCount,
      visibleGatewayOptionCount,
      visibleTargetOptionCount,
    };
  }, knownServerIds);
  const record = { phase, ...snapshot };
  diagnostics.push(record);
  try {
    await context.writeArtifactJson(`mobile-new-task-target-bar-diagnostic-${phase}.json`, record);
  } catch {
    // Diagnostic persistence must not prevent the UI contract assertions from running.
  }
  return record;
}

async function assertDraftContextReady(page, { language, expectedCwd, width, requirePermission = true }) {
  const onlineLabel = language === "zh-CN" ? "在线" : "Online";
  const permissionLabel = language === "zh-CN" ? "权限 · 默认" : "Permissions · Default";
  await page.waitForFunction(({ testId, label }) =>
    document.querySelector(`[data-testid="${testId}"]`)?.getAttribute("aria-label") === label,
  { testId: "draft-context-status", label: onlineLabel }, { timeout: 20_000 });
  const project = page.getByTestId("draft-context-project");
  const status = page.getByTestId("draft-context-status");
  const model = page.getByTestId("draft-model-selector");
  const permission = page.getByTestId("draft-permission-preview-button");
  await Promise.all([
    project.waitFor({ state: "visible", timeout: 20_000 }),
    model.waitFor({ state: "visible", timeout: 20_000 }),
    ...(requirePermission ? [permission.waitFor({ state: "visible", timeout: 20_000 })] : []),
  ]);
  const permissionVisible = await permission.isVisible().catch(() => false);
  const projectLabel = await project.getAttribute("aria-label");
  assert.ok(projectLabel?.includes(expectedCwd), `project control must expose the active cwd: ${expectedCwd}`);
  assert.equal(await status.getAttribute("aria-label"), onlineLabel,
    "the non-interactive status control must reflect the real owned Gateway connection");
  if (requirePermission) assert.equal(await permission.getAttribute("aria-label"), permissionLabel);
  assert.ok((await model.innerText()).trim().length > 0, "the existing target-level model selection remains visible");
  assert.equal(await page.getByTestId("draft-plugin-preview-button").count(), 0,
    "the final UI has no plugin action");
  assert.equal(await page.locator('[data-testid^="server-option-"]:visible').count(), 0,
    "draft must not render separate server-selection buttons");
  assert.equal(await page.locator('[data-testid^="gateway-option-"]:visible').count(), 0,
    "draft must not render separate Gateway-selection buttons");
  assert.equal(await page.locator('[data-testid^="target-option-"]:visible').count(), 0,
    "draft must not render separate target-selection buttons");
  assert.equal(await page.getByTestId("new-task-draft-target-action").count(), 0,
    "draft must not render a separate target action when context is ready");
  await assertLegacyAdvancedFormAbsent(page);

  const visual = await page.evaluate(() => {
    const rect = testId => {
      const node = document.querySelector(`[data-testid="${testId}"]`);
      if (!node) return null;
      const value = node.getBoundingClientRect();
      return { x: value.x, y: value.y, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
    };
    const bar = document.querySelector('[data-testid="draft-context-bar"]');
    const composer = document.querySelector('[data-testid="message-input-root"]');
    const barStyle = bar ? getComputedStyle(bar) : null;
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      lang: document.documentElement.lang,
      colorScheme: document.documentElement.style.colorScheme,
      project: rect("draft-context-project"),
      status: rect("draft-context-status"),
      barBottom: bar?.getBoundingClientRect().bottom ?? null,
      composerTop: composer?.getBoundingClientRect().top ?? null,
      barComposerGap: bar && composer ? composer.getBoundingClientRect().top - bar.getBoundingClientRect().bottom : null,
      barCornerRadii: barStyle ? [barStyle.borderTopLeftRadius, barStyle.borderTopRightRadius,
        barStyle.borderBottomRightRadius, barStyle.borderBottomLeftRadius] : null,
      barChildren: bar ? [...bar.children].map(node => node.getAttribute("data-testid")) : null,
      statusTag: document.querySelector('[data-testid="draft-context-status"]')?.tagName.toLowerCase() ?? null,
      statusRole: document.querySelector('[data-testid="draft-context-status"]')?.getAttribute("role") ?? null,
    };
  });
  assert.equal(visual.viewportWidth, width);
  assert.equal(visual.documentWidth, width, `draft must not overflow at ${width}px`);
  assert.equal(visual.lang, language);
  assert.ok(["light", "dark"].includes(visual.colorScheme));
  assert.deepEqual(visual.barChildren, ["draft-context-project", "draft-context-status"],
    "the same context bar contains only the project selector and real connection status");
  assert.equal(visual.barComposerGap, 4, "the project bar must leave exactly 4px before the composer without overlap");
  assert.deepEqual(visual.barCornerRadii, ["0px", "0px", "0px", "0px"],
    "the project/status bar must not render as a pill or rounded cap");
  assert.ok(visual.statusTag !== "button" && visual.statusRole !== "button",
    "connection status is informational and not interactive");
  assert.ok(visual.project && visual.status && visual.status.x >= visual.project.x,
    "project and status controls must appear in adjacent left-to-right order");
  assert.ok(visual.status.x - visual.project.right <= 24,
    "project and status controls must stay adjacent on the left");
  assert.ok(visual.project.right <= width && visual.status.right <= width,
    "project and status controls must fit inside the logical viewport");
  const workspaceStatus = page.getByTestId("new-task-draft-workspace-status");
  return {
    visual,
    modelLabel: (await model.innerText()).trim(),
    permissionLabel: permissionVisible ? await permission.getAttribute("aria-label") : null,
    permissionVisible,
    workspaceStatusText: await workspaceStatus.count() ? await workspaceStatus.innerText() : null,
  };
}

async function assertLegacyAdvancedFormAbsent(page) {
  for (const testId of [
    "new-task-advanced",
    "workspace-path",
    "new-task-add-project",
    "workspace-isolation-worktree",
    "new-workspace-prompt",
  ]) {
    assert.equal(await page.getByTestId(testId).count(), 0,
      `simplified New draft must not render removed advanced form control ${testId}`);
  }
}

async function verifyDraftContextInteractions(page, {
  context, fixture, selectedTarget, observer, modelMetadataFixture, profileId, permissionScreenshot,
}) {
  const sharedPath = fixture.sharedPath;
  const initialRoute = new URL(page.url());
  assert.equal(initialRoute.searchParams.get("profileId"), profileId,
    "the draft route remains under the active paired profile");
  const initialServerId = initialRoute.searchParams.get("serverId");
  const initialModelLabel = (await page.getByTestId("draft-model-selector").innerText()).trim();
  const initialStatus = await page.getByTestId("draft-context-status").getAttribute("aria-label");
  const promptText = "保留的待发送草稿\n切换项目后继续编辑";
  const composer = page.getByTestId("new-task-draft");
  const prompt = page.getByTestId("message-input");
  await prompt.fill(promptText);
  assert.equal(await prompt.inputValue(), promptText, "the unsent draft text must be visible before project selection");
  await page.evaluate(() => {
    window.__kcoderDraftContextRootBefore = document.querySelector('[data-testid="new-task-draft"]');
    window.__kcoderDraftContextInputBefore = document.querySelector('[data-testid="message-input"]');
  });
  await prompt.blur();
  const expandedDraftScreenshot = "2026-10-15-new-task-target-context-draft-expanded-390-zh-CN-light.png";
  await page.screenshot({ path: context.pathInArtifacts(expandedDraftScreenshot), animations: "disabled" });

  const trackedRpcCount = observer.calls.length;
  const modelRequestCount = modelMetadataFixture.requests.length;
  const project = page.getByTestId("draft-context-project");
  await project.click();
  const projectModal = page.getByTestId("draft-context-project-modal");
  await projectModal.waitFor({ state: "visible", timeout: 15_000 });
  const alphaOption = page.getByTestId(draftProjectOptionTestId(selectedTarget.serverId, selectedTarget.defaultCwd));
  const sharedOption = page.getByTestId(draftProjectOptionTestId(selectedTarget.serverId, sharedPath));
  const otherTargetDefaults = fixture.deployments.filter(target => target.id === selectedTarget.id && target.serverId !== selectedTarget.serverId);
  const otherTargetOptions = otherTargetDefaults.map(target => ({
    target,
    locator: page.getByTestId(draftProjectOptionTestId(target.serverId, target.defaultCwd)),
  }));
  await Promise.all([
    alphaOption.waitFor({ state: "visible", timeout: 15_000 }),
    sharedOption.waitFor({ state: "visible", timeout: 15_000 }),
    ...otherTargetOptions.map(option => option.locator.waitFor({ state: "visible", timeout: 15_000 })),
  ]);
  assert.equal(await page.locator('[data-testid^="draft-context-project-option-"]:visible').count(), 2 + otherTargetOptions.length,
    "the project sheet must list this target's RPC-registered roots and each other configured target's default workspace");
  assert.equal(await alphaOption.locator("svg").count(), 1, "the routed cwd must be selected before a change");
  assert.equal(await sharedOption.locator("svg").count(), 0, "the other fixed workspace starts unselected");
  for (const option of otherTargetOptions) assert.equal(await option.locator.locator("svg").count(), 0,
    "another target's default workspace must be available without becoming the implicit selection");
  await sharedOption.click();
  await projectModal.waitFor({ state: "hidden", timeout: 15_000 });
  await page.waitForFunction(path =>
    document.querySelector('[data-testid="draft-context-project"]')?.getAttribute("aria-label")?.includes(path),
  sharedPath, { timeout: 15_000 });
  assert.equal(await prompt.inputValue(), promptText, "selecting a workspace must preserve the same unsent composer draft");
  assert.equal(await page.evaluate(() => window.__kcoderDraftContextRootBefore === document.querySelector('[data-testid="new-task-draft"]')), true,
    "the project change must remain within the existing NewTaskDraft instance");
  assert.equal(await page.evaluate(() => window.__kcoderDraftContextInputBefore === document.querySelector('[data-testid="message-input"]')), true,
    "the project change must preserve the same composer input node");
  assert.equal(new URL(page.url()).pathname, initialRoute.pathname, "project selection must not navigate away from the draft");
  assert.equal(new URL(page.url()).searchParams.get("profileId"), profileId, "project selection must not switch the active profile");
  assert.equal(new URL(page.url()).searchParams.get("serverId"), initialServerId, "project selection must not switch the selected target");
  assert.equal((await page.getByTestId("draft-model-selector").innerText()).trim(), initialModelLabel,
    "project selection must preserve the existing target-level model selection");
  assert.equal(await page.getByTestId("draft-context-status").getAttribute("aria-label"), initialStatus,
    "project selection must preserve the actual active Gateway connection status");

  await project.click();
  await projectModal.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await sharedOption.locator("svg").count(), 1, "the selected project must be checked when the sheet is reopened");
  assert.equal(await alphaOption.locator("svg").count(), 0, "the former cwd must no longer be selected");
  await page.keyboard.press("Escape");
  await projectModal.waitFor({ state: "hidden", timeout: 15_000 });
  await project.click();
  await projectModal.waitFor({ state: "visible", timeout: 15_000 });
  await alphaOption.click();
  await page.waitForFunction(path =>
    document.querySelector('[data-testid="draft-context-project"]')?.getAttribute("aria-label")?.includes(path),
  selectedTarget.defaultCwd, { timeout: 15_000 });
  assert.equal(await prompt.inputValue(), promptText, "restoring the original workspace must keep the draft intact");
  assert.equal(observer.calls.length, trackedRpcCount, "workspace selection is local draft state and must not issue runtime RPC");
  assert.equal(modelMetadataFixture.requests.length, modelRequestCount,
    "workspace selection must not reload model metadata or switch target catalogs");

  const permission = page.getByTestId("draft-permission-preview-button");
  const permissionModal = page.getByTestId("draft-feature-preview-modal");
  const permissionPending = page.getByTestId("draft-feature-preview-pending");
  await permission.click();
  await permissionModal.waitFor({ state: "visible", timeout: 15_000 });
  assert.ok((await permissionPending.innerText()).includes("预览 · 尚未接入"));
  assert.ok((await permissionModal.innerText()).includes("新会话仍沿用运行目标的默认权限。"),
    "permission preview must state that actual conversations still use the target default");
  assert.equal(await permissionModal.locator("input, textarea, select, [role=checkbox], [role=radio]").count(), 0,
    "permission preview must expose no editable or selectable settings");
  assert.equal(await permissionModal.locator('[data-testid^="draft-feature-preview-option-"]').count(), 0,
    "permission preview must contain no choice rows");
  const permissionModalChildren = await permissionModal.locator("button").count();
  assert.equal(permissionModalChildren, 1, "permission preview exposes only its close control");
  await page.screenshot({ path: context.pathInArtifacts(permissionScreenshot), animations: "disabled" });
  await page.keyboard.press("Escape");
  await permissionModal.waitFor({ state: "hidden", timeout: 15_000 });
  await permission.click();
  await permissionModal.waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("draft-feature-preview-close").click();
  await permissionModal.waitFor({ state: "hidden", timeout: 15_000 });
  assert.equal(observer.calls.length, trackedRpcCount, "opening and closing the permission preview must issue no runtime RPC");
  assert.equal(modelMetadataFixture.requests.length, modelRequestCount, "permission preview must not load model/plugin catalogs");
  assert.equal(await page.getByTestId("draft-plugin-preview-button").count(), 0, "no plugin control is part of the final UI scope");
  return {
    projectSelection: {
      availablePaths: [selectedTarget.defaultCwd, sharedPath],
      otherTargetDefaultPaths: otherTargetDefaults.map(target => ({ serverId: target.serverId, path: target.defaultCwd })),
      changedTo: sharedPath,
      restoredTo: selectedTarget.defaultCwd,
      routeProfileId: profileId,
      selectedServerId: selectedTarget.serverId,
      routeCwdAssertion: "intentionally omitted because route params.cwd remains the entry value; active cwd was read from the project control's current aria-label and selected option marker",
      draftTextRetained: promptText,
      sameDraftRootNode: true,
      sameComposerInputNode: true,
      trackedRpcCountBeforeAndAfter: trackedRpcCount,
      modelMetadataRequestCountBeforeAndAfter: modelRequestCount,
      projectPickerEscapeClosed: true,
    },
    permissionPreview: {
      readOnly: true,
      pendingText: await permissionPending.innerText().catch(() => "预览 · 尚未接入"),
      escapeClosed: true,
      closeButtonClosed: true,
      trackedRpcCountBeforeAndAfter: trackedRpcCount,
      modelMetadataRequestCountBeforeAndAfter: modelRequestCount,
      screenshot: permissionScreenshot,
    },
    expandedDraftScreenshot,
  };
}

async function verifyDraftContextLayoutMatrix(page, { homeOrigin, profileId, selectedTarget, alphaTargets, context }) {
  const cases = [];
  for (const language of ["zh-CN", "en"]) {
    for (const theme of ["light", "dark"]) {
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${homeOrigin}/mobile/h/${encodeURIComponent(profileId)}`, { waitUntil: "domcontentloaded" });
        await page.evaluate(({ key, language, theme }) => {
          const previous = JSON.parse(localStorage.getItem(key) || "null") || {};
          localStorage.setItem(key, JSON.stringify({ ...previous, language, theme }));
        }, { key: "kcoder-studio:mobile-app-preferences:v1", language, theme });
        await page.emulateMedia({ colorScheme: theme });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(expected => document.documentElement.lang === expected, language, { timeout: 15_000 });
        await page.waitForFunction(expected => document.documentElement.style.colorScheme === expected, theme, { timeout: 15_000 });
        await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 20_000 });
        await waitForHomeRows(page, alphaTargets);
        const groupIndex = await findHomeWorkspaceIndex(page, selectedTarget);
        await page.getByTestId(`new-workspace-${selectedTarget.serverId}-${groupIndex}`).click();
        await page.waitForURL(url => url.pathname.replace(/\/$/, "") === "/mobile/new", { timeout: 20_000 });
        const route = assertDraftRouteIdentity(page, { profileId, serverId: selectedTarget.serverId, cwd: selectedTarget.defaultCwd });
        await page.getByTestId("new-task-draft").waitFor({ state: "visible", timeout: 20_000 });
        await waitForDraftOptionsReady(page, language);
        const ready = await assertDraftContextReady(page, { language, expectedCwd: selectedTarget.defaultCwd, width });
        const isPrimary = width === 390 && language === "zh-CN" && theme === "light";
        let screenshot = null;
        if (!isPrimary) {
          const name = `2026-10-15-new-task-target-context-${width}-${language}-${theme}-after.png`;
          await page.screenshot({ path: context.pathInArtifacts(name), animations: "disabled" });
          screenshot = { name, logicalViewport: { width, height: 844 }, locale: language, theme, state: "normal" };
        }
        cases.push({ language, theme, width, route, ...ready, screenshot });
      }
    }
  }
  assert.equal(cases.length, 8, "all two-width, two-locale, two-theme combinations must be exercised");
  return cases;
}

async function waitForHomeRows(page, targets) {
  for (const target of targets) {
    await page.getByTestId(`home-workspace-row-${target.serverId}-0`).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId(`home-workspace-row-${target.serverId}-1`).waitFor({ state: "visible", timeout: 30_000 });
  }
}

async function findHomeWorkspaceIndex(page, target) {
  const rows = await page.locator(`[data-testid^="home-workspace-row-${target.serverId}-"]`).evaluateAll(nodes =>
    nodes.map(node => ({ testId: node.getAttribute("data-testid"), text: node.textContent ?? "" })));
  const match = rows.find(row => row.text.includes(target.defaultCwd));
  assert.ok(match, `${target.targetAlias} exact registered workspace path must be visible in the real Home workspace row`);
  const index = Number(match.testId?.match(/-(\d+)$/)?.[1]);
  assert.ok(Number.isSafeInteger(index), "Home workspace row must retain its numeric group index");
  return index;
}

function routeSummary(value) {
  return new URL(value);
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

function byLocalePath(entries) {
  return [...entries].sort((left, right) => left.path.localeCompare(right.path));
}
