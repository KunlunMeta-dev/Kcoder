import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import {
  buildGatewayMobileWebManifest,
  MOBILE_WEB_BASE_TOKEN,
  writeGatewayMobileWebManifest,
} from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import {
  archiveMobileWebExport,
  inspectMobileWebExportSourceIdentity,
  restoreMobileWebExportArchive,
} from "../harness/mobile-web-export-archive.mjs";
import { appRoot, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const EXPECTED_HEAD = "5f49da119ed80744692d2b081063f30b1bd19243";
const HISTORICAL_REFERENCE_RUN = "20261014-104736.864Z";
const HISTORICAL_SOURCE_TREE_SHA256 = "5ee0db848f1bb03a64c3c20ce27714f2a8f31f40819d4298704cc2212ee89170";
const HISTORICAL_MOBILE_SOURCE_SHA256 = "961718162fc88d1c1286fa8601bab6f36ef5b34720bce160c7b2820a4e776086";
const HISTORICAL_BUNDLE_SHA256 = "be35dd7d43a395366aba174c7c21ec103e5b2cf48eca07256a7c665b196ea790";
const HISTORICAL_GATEWAY_MANIFEST_SHA256 = "6ae5de6e4bf8c3fcda28765e5bf7ad09020d01e9c2f966401a6986f4dbaebb42";
const historicalReferenceArtifacts = resolve(
  repoRoot,
  "target/test/apps/kcoder-studio/e2e/private/mobile-workspace-history-menu.once.e2e.mjs",
  HISTORICAL_REFERENCE_RUN,
  "artifacts",
);
const historicalScreenshots = [
  {
    sourceName: "after-home-390-zh-CN-dark.png",
    artifactName: "reference-before-home-390-zh-CN-dark.png",
    sha256: "a5bef6a738062a1af7017bd5525287aaebef179792f74ba295add48374e2a522",
  },
  {
    sourceName: "after-home-menu-390-zh-CN-dark.png",
    artifactName: "reference-before-target-actions-menu-390-zh-CN-dark.png",
    sha256: "469e3914e6979f835ca511221c8c477963ce029285cc8f481c8775d807aef221",
  },
];
const configuredBinary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
assert.ok(isAbsolute(configuredBinary), "KCODER_E2E_KCODER_BIN must be an absolute path when provided");
await Promise.all([
  access(configuredBinary),
  access(resolve(appRoot, "mobile/node_modules/expo/package.json")),
]);

await runE2E(import.meta.url, {
  testId: "mobile-home-workspace-history-menu-real-web-rpc",
  tier: "manual-live",
  retainSuccessLogs: true,
  modelPolicy: "current-source Mobile Web export or explicitly pinned same-source archive restore, pinned historical screenshot references, isolated local Gateway/app-server/workspaces, real history-refresh RPCs only; no Provider or model request",
}, async context => {
  assert.equal(context.gitCommit, EXPECTED_HEAD, "run must use the agreed source HEAD");

  const historicalReferenceEvidence = await copyPinnedHistoricalScreenshots(context);

  const sourceIdentity = await inspectMobileWebExportSourceIdentity({
    sourceRoots: [
      { name: "mobile", path: resolve(appRoot, "mobile"), destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: resolve(appRoot, "shared"), destination: "apps/kcoder-studio/shared" },
    ],
  });
  const archivePath = process.env.KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE;
  const archiveSha256 = process.env.KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE_SHA256;
  assert.equal(Boolean(archivePath), Boolean(archiveSha256),
    "archive reuse requires both KCODER_E2E_MOBILE_WEB_EXPORT_ARCHIVE and its SHA-256 pin");
  let current;
  let currentArchive;
  if (archivePath) {
    current = await restoreMobileWebExportArchive(context, {
      archivePath,
      expectedArchiveSha256: archiveSha256,
      sourceIdentity,
      outputName: "workspace-history-menu-restored-mobile-web",
    });
    currentArchive = {
      path: current.archivePath,
      sha256: current.archiveSha256,
      size: null,
      bundleSha256: current.bundleSha256,
      inputKind: current.inputKind,
    };
  } else {
    current = await exportMobileWeb(context, {
      label: "workspace-history-menu-current-mobile-web",
      outputName: "workspace-history-menu-current-mobile-web",
      dependencyRoot: process.env.KCODER_E2E_MOBILE_DEPENDENCY_ROOT || undefined,
      timeoutMs: 10 * 60_000,
      overallTimeoutMs: 45 * 60_000,
      deployMount: true,
    });
    currentArchive = await archiveMobileWebExport(context, { exportResult: current, sourceIdentity });
  }
  assert.equal(current.sourceTreeSha256, sourceIdentity.sourceTreeSha256,
    "current Mobile Web bundle must match the exact Mobile/shared source roots inspected for this run");
  const currentManifest = await buildGatewayMobileWebManifest(current.path, {
    expectedFiles: current.bundleFiles,
  });
  await writeGatewayMobileWebManifest(current.path, currentManifest);
  const currentManifestBytes = await readFile(resolve(current.path, "kcoder-mobile-web.json"));
  const currentManifestSha256 = sha256(currentManifestBytes);

  await context.writeArtifactJson("mobile-workspace-history-menu-build-provenance.json", {
    sourceHead: context.gitCommit,
    currentSourceTreeSha256: current.sourceTreeSha256,
    currentBundleSha256: current.bundleSha256,
    currentBundleFileCount: current.bundleFileCount,
    currentDependencySourceTreeSha256: current.dependencySourceTreeSha256 ?? current.origin?.dependencySourceTreeSha256 ?? null,
    currentGatewayManifestSha256: currentManifestSha256,
    currentInputKind: current.inputKind ?? "fresh-export",
    currentExportArchive: {
      path: currentArchive.path,
      sha256: currentArchive.sha256,
      size: currentArchive.size,
      bundleSha256: currentArchive.bundleSha256,
      inputKind: currentArchive.inputKind ?? "fresh-export-archived",
    },
    historicalReferenceRun: HISTORICAL_REFERENCE_RUN,
    historicalSourceTreeSha256: HISTORICAL_SOURCE_TREE_SHA256,
    historicalMobileSourceSha256: HISTORICAL_MOBILE_SOURCE_SHA256,
    historicalBundleSha256: HISTORICAL_BUNDLE_SHA256,
    historicalGatewayManifestSha256: HISTORICAL_GATEWAY_MANIFEST_SHA256,
    historicalScreenshots: historicalReferenceEvidence,
    historicalReferenceState: "one earlier scratch workspace; prior UI showed target header and LOCAL/chevron row; status was refreshing; not same workspace data as this run",
    providerOrModelRequest: false,
  });

  const scratchRoot = await context.createOwnedScratchDirectory("workspace-history-menu", {
    baseDirectory: "/tmp",
  });
  const workspaces = {
    Alpha: context.pathInScratch(scratchRoot, "current", "Alpha"),
    Beta: context.pathInScratch(scratchRoot, "current", "Beta-workspace-with-a-long-path-for-narrow-layout"),
  };
  await Promise.all(Object.values(workspaces).map(path => mkdir(path, { recursive: true })));

  const currentGateway = await startGateway(context, {
    auth: true,
    label: "workspace-history-menu-current-gateway",
    workspace: workspaces.Alpha,
    kcoderBin: configuredBinary,
    env: {
      KCODER_STUDIO_WEB_ROOT: "",
      KCODER_STUDIO_MOBILE_WEB_ROOT: current.path,
    },
  });
  await verifyMountedEntry(
    context,
    currentGateway,
    current.path,
    currentManifest.files,
    currentManifestSha256,
    "current-mobile-web-mounted-entry.json",
  );

  const chromium = await startChromium(context, {
    label: "workspace-history-menu-owned-chromium",
    startTimeoutMs: 60_000,
  });
  const diagnostics = [];
  const rpc = [];
  const provisioning = {};
  const forbiddenModelRequests = [];
  const currentPageErrors = [];

  for (const deployment of [
    { id: "current", gateway: currentGateway, paths: workspaces },
  ]) {
    const provisionContext = await chromium.browser.newContext({
      locale: "en",
      colorScheme: "light",
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    const closeProvisionContext = ownedContextCleanup(
      context,
      "close " + deployment.id + " workspace-provision context",
      provisionContext,
    );
    let page = null;
    let homePath = null;
    let provisionStage = "provision-context-created";
    try {
      page = await provisionContext.newPage();
      observePage(page, diagnostics, currentPageErrors, deployment.id);
      observeRpc(page, rpc, deployment.paths, {
        deployment: deployment.id,
        forbiddenModelRequests,
      });
      await connect(page, deployment.gateway);
      const homeUrl = page.url();
      homePath = new URL(homeUrl).pathname;
      provisionStage = "connected-home";

      await page.getByTestId("new-workspace").click();
      await page.waitForURL(url => url.pathname.endsWith("/new"), { timeout: 20_000 });
      provisionStage = "new-workspace-route";
      const compactDraft = page.getByTestId("new-task-draft");
      const advancedToggle = page.getByTestId("new-task-advanced");
      const addProject = page.getByTestId("new-task-add-project");
      await advancedToggle.waitFor({ state: "visible", timeout: 20_000 });
      await waitFor(
        async () => await compactDraft.isVisible() || await addProject.isVisible(),
        20_000,
        "new-task compact draft or Advanced project controls to render",
        50,
        context.abortSignal,
      );
      if (await compactDraft.isVisible()) {
        const label = await advancedToggle.getAttribute("aria-label");
        assert.ok(["Advanced conversation options", "高级会话选项"].includes(label),
          "compact draft must expose the real Advanced toggle");
        await advancedToggle.click();
      } else {
        const label = await advancedToggle.getAttribute("aria-label");
        assert.ok(["Back to conversation", "返回对话"].includes(label),
          "an already-open Advanced form must expose its return-to-draft toggle");
      }
      await addProject.waitFor({ state: "visible", timeout: 20_000 });
      provisionStage = "advanced-add-project";
      await waitFor(
        () => addProject.isEnabled(),
        30_000,
        "the single owned Local target to enable Add Project",
        50,
        context.abortSignal,
      );
      await addProject.click();
      await page.getByTestId("open-project-route").waitFor({ state: "visible", timeout: 20_000 });
      provisionStage = "open-project-route";
      await page.getByTestId("open-project-server-local").click();
      const workspaceField = page.getByTestId("open-project-path");
      await workspaceField.waitFor({ state: "visible", timeout: 10_000 });
      await workspaceField.fill(deployment.paths.Beta);
      assert.equal(resolve(await workspaceField.inputValue()), resolve(deployment.paths.Beta));

      const openButton = page.getByTestId("open-project-submit");
      await waitFor(
        () => openButton.isEnabled(),
        30_000,
        "owned Beta workspace open action to become available",
        50,
        context.abortSignal,
      );
      const openRequestStart = rpc.filter(item => item.deployment === deployment.id && item.method === "runtime.workspaces.openV2").length;
      provisionStage = "beta-open-v2-submit";
      await openButton.click();
      await page.waitForURL(url => url.pathname === "/mobile/new" &&
        url.searchParams.get("serverId") === "local" &&
        resolve(url.searchParams.get("cwd") || "") === resolve(deployment.paths.Beta), { timeout: 30_000 });
      await waitFor(
        () => rpc.some(item =>
          item.deployment === deployment.id &&
          item.method === "runtime.workspaces.openV2" &&
          item.workspaceAlias === "Beta" &&
          item.response?.errorCode === null &&
          item.response?.workspaceReady === true &&
          item.response?.workspaceMatches === true),
        30_000,
        "real runtime.workspaces.openV2 ACK for the owned Beta workspace",
        50,
        context.abortSignal,
      );
      const openRequests = rpc.filter(item => item.deployment === deployment.id && item.method === "runtime.workspaces.openV2");
      assert.equal(openRequests.length - openRequestStart, 1, "registering Beta must make one real openV2 request");
      const openRequest = openRequests.at(-1);
      assert.equal(openRequest.serverId, "local");
      assert.equal(openRequest.workspaceAlias, "Beta");
      assert.equal(openRequest.response?.errorCode, null);
      assert.equal(openRequest.response?.workspaceReady, true);
      assert.equal(openRequest.response?.workspaceMatches, true);
      assert.equal(new URL(page.url()).pathname, "/mobile/new");
      const route = new URL(page.url());
      assert.equal(route.searchParams.get("serverId"), "local");
      assert.equal(resolve(route.searchParams.get("cwd") || ""), resolve(deployment.paths.Beta));
      assert.equal(route.searchParams.get("operationReceiptVersion"), "2");
      assert.equal(route.searchParams.get("operationKind"), "open");
      assert.ok(route.searchParams.get("operationReceiptId"));
      assert.equal(openRequest.response?.scopeVersion, 2);
      assert.equal(openRequest.response?.receiptIdPresent, true);

      await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
      await waitForHomeRows(page, context, rpc, deployment.id);
      provisioning[deployment.id] = {
        routePath: homePath,
        betaOpenV2RequestCount: 1,
        betaRouteScopeMatches: true,
        betaReceiptReady: true,
        catalogPublishedTwoScopes: true,
      };
    } catch (failure) {
      if (page && homePath) {
        await captureProvisionFailure(context, page, homePath, provisionStage, rpc).catch(() => {});
      }
      throw failure;
    } finally {
      await closeProvisionContext();
    }
  }

  const combinations = [
    { locale: "zh-CN", language: "zh-CN", theme: "light" },
    { locale: "zh-CN", language: "zh-CN", theme: "dark" },
    { locale: "en", language: "en", theme: "light" },
    { locale: "en", language: "en", theme: "dark" },
  ];
  const layout = [];
  const workspaceMenus = [];
  let betaGroupIndex = null;
  let singleWorkspaceEvidence = null;
  let globalBatchEvidence = null;

  for (const deployment of [
    { id: "current", gateway: currentGateway, paths: workspaces },
  ]) {
    for (const combo of combinations) {
      const browserContext = await chromium.browser.newContext({
        locale: combo.locale,
        colorScheme: combo.theme,
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
      });
      const closeBrowserContext = ownedContextCleanup(
        context,
        "close " + deployment.id + " " + combo.language + "-" + combo.theme + " Chromium context",
        browserContext,
      );
      let page = null;
      let homeUrl = null;
      let homePath = null;
      let layoutStage = "layout-context-created";
      try {
        page = await browserContext.newPage();
        observePage(page, diagnostics, currentPageErrors, deployment.id);
        observeRpc(page, rpc, deployment.paths, {
          deployment: deployment.id,
          forbiddenModelRequests,
        });
        await connect(page, deployment.gateway);
        homeUrl = page.url();
        homePath = new URL(homeUrl).pathname;
        layoutStage = "connected-home";
        await waitForHomeRows(page, context, rpc, deployment.id);
        await page.waitForFunction(
          expected => document.documentElement.lang === expected,
          combo.language,
          { timeout: 10_000 },
        );
        await page.waitForFunction(
          expected => document.documentElement.style.getPropertyValue("--mobile-color-scheme") === expected,
          combo.theme,
          { timeout: 10_000 },
        );
        const groupIndices = [0, 1];
        const rowText = new Map();
        for (const index of groupIndices) {
          const toggle = page.getByTestId(index === 0 ? "toggle-server-local" : "toggle-workspace-local-" + index);
          await toggle.waitFor({ state: "visible", timeout: 20_000 });
          rowText.set(index, await toggle.innerText());
        }
        const betaIndex = groupIndices.find(index => {
          const text = rowText.get(index) || "";
          return text.includes(deployment.paths.Beta) || text.includes("Beta-workspace");
        });
        assert.notEqual(betaIndex, undefined, "the Beta workspace must have its own Home row");
        assert.ok(groupIndices.some(index => {
          const text = rowText.get(index) || "";
          return text.includes(deployment.paths.Alpha) || text.includes("Alpha");
        }), "the Alpha workspace must remain in the Home scope list");
        layoutStage = "home-workspace-fold";
        const foldState = await assertWorkspaceRowsToggleIndependently(page, context);

        if (deployment.id === "current") {
          betaGroupIndex = betaIndex;
          for (const index of groupIndices) {
            await page.getByTestId("workspace-actions-local-" + index).waitFor({ state: "visible", timeout: 10_000 });
            await page.getByTestId("new-workspace-local-" + index).waitFor({ state: "visible", timeout: 10_000 });
            assert.doesNotMatch(rowText.get(index) || "", /\b(?:LOCAL|SSH|WORKTREE)\b/i,
              "workspace rows must not repeat target transport labels");
          }
          assert.equal(await page.getByTestId("workspace-actions-local").count(), 0,
            "the current Home no longer has a separate target-level actions header");
          assert.equal(await page.getByTestId("new-workspace-local").count(), 0,
            "the current Home no longer has a separate target-level Plus header");
        }

        for (const width of [320, 390]) {
          const height = width === 320 ? 568 : 844;
          layoutStage = "home-layout-" + width + "-" + combo.language + "-" + combo.theme;
          await page.setViewportSize({ width, height });
          const visual = await page.evaluate(() => ({
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            documentWidth: document.documentElement.scrollWidth,
            lang: document.documentElement.lang,
            theme: document.documentElement.style.getPropertyValue("--mobile-color-scheme"),
          }));
          assert.equal(visual.viewportWidth, width);
          assert.equal(visual.viewportHeight, height);
          assert.equal(visual.documentWidth, width, "Home actions must not cause horizontal overflow");
          assert.equal(visual.lang, combo.language);
          assert.equal(visual.theme, combo.theme);
          layout.push({
            deployment: deployment.id,
            language: combo.language,
            theme: combo.theme,
            logicalViewport: { width, height },
            deviceScaleFactor: 2,
            noHorizontalOverflow: true,
          });
          await page.screenshot({
            path: context.pathInArtifacts(
              "after-home-" + width + "-" + combo.language + "-" + combo.theme + ".png",
            ),
            animations: "disabled",
          });
          layoutStage = "workspace-menu-" + width + "-" + combo.language + "-" + combo.theme;
          workspaceMenus.push(await verifyWorkspaceMenuLayout(
            page,
            deployment,
            betaIndex,
            width,
            height,
            combo,
            foldState,
            rpc,
            context,
          ));
        }

        if (deployment.id === "current" && combo.language === "zh-CN" && combo.theme === "dark") {
          await page.setViewportSize({ width: 390, height: 844 });
          layoutStage = "workspace-plus-route";
          await assertPlusRoutesToWorkspace(page, deployment, betaIndex, homeUrl, foldState, rpc, context);

          layoutStage = "single-workspace-refresh";
          singleWorkspaceEvidence = await verifySingleWorkspaceAction(page, deployment, betaIndex, homeUrl, rpc, context);
          layoutStage = "global-workspace-refresh";
          await waitForHomeRows(page, context, rpc, deployment.id);
          globalBatchEvidence = await verifyGlobalBatchAction(page, deployment, betaIndex, deployment.paths, homeUrl, rpc, context);
        }
      } catch (failure) {
        if (page && homePath) {
          await captureProvisionFailure(context, page, homePath, layoutStage, rpc).catch(() => {});
        }
        throw failure;
      } finally {
        await closeBrowserContext();
      }
    }
  }

  assert.notEqual(betaGroupIndex, null, "current source must expose a separately indexed Beta row");
  assert.equal(layout.length, 8, "Home must be checked at 320/390 across language and theme combinations");
  assert.equal(workspaceMenus.length, 8, "each Home layout combination must open and measure its workspace action menu");
  assert.equal(singleWorkspaceEvidence?.allReady, true, "single-scope history refresh must finish on its owner cursor");
  assert.equal(globalBatchEvidence?.allReady, true, "all-workspaces history refresh must finish on every owner cursor");
  assert.deepEqual(forbiddenModelRequests, [], "history actions and Plus navigation must not start a model task");
  assert.deepEqual(currentPageErrors, [], "current UI interactions must not raise uncaught page errors");
  assert.deepEqual(diagnostics.filter(item => item.kind === "pageerror"), [],
    "current pages must not raise uncaught page errors");

  await context.writeArtifactJson("mobile-workspace-history-menu-browser-evidence.json", {
    sourceHead: context.gitCommit,
    historicalScreenshotReference: historicalReferenceEvidence,
    current: {
      sourceTreeSha256: current.sourceTreeSha256,
      bundleSha256: current.bundleSha256,
      gatewayManifestSha256: currentManifestSha256,
      inputKind: current.inputKind ?? "fresh-export",
      exportArchiveSha256: currentArchive.sha256,
    },
    provisioning,
    viewportLocaleThemeCases: layout,
    workspaceMenuViewportCases: workspaceMenus,
    betaGroupIndex,
    singleWorkspaceAction: singleWorkspaceEvidence,
    globalBatchAction: globalBatchEvidence,
    providerOrModelRequest: false,
    forbiddenModelRequests,
    diagnostics,
    secretDataInEvidence: false,
  });
  return {
    historicalScreenshotReferenceRun: HISTORICAL_REFERENCE_RUN,
    viewportLocaleThemeCases: layout.length,
    registeredWorkspacesPerTarget: 2,
    betaGroupIndex,
    singleWorkspaceReady: singleWorkspaceEvidence?.allReady === true,
    globalBatchReady: globalBatchEvidence?.allReady === true,
    providerOrModelRequest: false,
  };
});

async function copyPinnedHistoricalScreenshots(context) {
  const screenshots = [];
  for (const reference of historicalScreenshots) {
    const sourcePath = resolve(historicalReferenceArtifacts, reference.sourceName);
    const bytes = await readFile(sourcePath);
    const actualSha256 = sha256(bytes);
    assert.equal(actualSha256, reference.sha256,
      `historical screenshot reference changed: ${reference.sourceName}`);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a",
      `historical screenshot is not a PNG: ${reference.sourceName}`);
    const pixelSize = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    assert.deepEqual(pixelSize, { width: 780, height: 1688 },
      `historical screenshot pixel size differs from its pinned 390x844/DSF2 context: ${reference.sourceName}`);
    const destination = context.pathInArtifacts(reference.artifactName);
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    assert.equal(sha256(await readFile(destination)), reference.sha256,
      `copied historical screenshot SHA differs: ${reference.sourceName}`);
    screenshots.push({
      sourceName: reference.sourceName,
      sourcePath,
      artifactName: reference.artifactName,
      sha256: reference.sha256,
      pixelSize,
      logicalViewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      locale: "zh-CN",
      theme: "dark",
    });
  }
  return {
    run: HISTORICAL_REFERENCE_RUN,
    sourceHead: EXPECTED_HEAD,
    sourceTreeSha256: HISTORICAL_SOURCE_TREE_SHA256,
    mobileSourceSha256: HISTORICAL_MOBILE_SOURCE_SHA256,
    bundleSha256: HISTORICAL_BUNDLE_SHA256,
    gatewayManifestSha256: HISTORICAL_GATEWAY_MANIFEST_SHA256,
    dataAndUiState: "one prior scratch workspace; prior target header and LOCAL/chevron row; server-status refresh was visible; separate from this run's two scratch workspaces",
    strictSameStatePixelComparison: false,
    screenshots,
  };
}

async function connect(page, gateway) {
  const response = await page.goto(new URL("/login?returnTo=%2Fmobile%2F", gateway.baseUrl).href, {
    waitUntil: "domcontentloaded",
  });
  assert.equal(response?.status(), 200);
  assert.equal(new URL(page.url()).pathname, "/login");
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForURL(url => url.pathname === "/mobile/", { timeout: 15_000 }),
    page.locator("form button").click(),
  ]);
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForHomeRows(page, context, rpc, deploymentId) {
  await page.getByTestId("toggle-server-local").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("toggle-workspace-local-1").waitFor({ state: "visible", timeout: 30_000 });
  if (deploymentId === "current") {
    for (const index of [0, 1]) {
      await page.getByTestId("workspace-actions-local-" + index).waitFor({ state: "visible", timeout: 20_000 });
      await page.getByTestId("new-workspace-local-" + index).waitFor({ state: "visible", timeout: 20_000 });
    }
  }
  const requiredCatalogMethods = deploymentId === "current"
    ? ["runtime.workspaces.list", "runtime.worktrees.list"]
    : ["runtime.workspaces.list"];
  await waitFor(
    () => requiredCatalogMethods.every(method => rpc.some(item =>
      item.deployment === deploymentId && item.method === method && item.response?.status === "success",
    )),
    30_000,
    "Home workspace and worktree catalogs to settle for the active owner",
    50,
    context.abortSignal,
  );
}

function workspaceToggle(page, index) {
  return page.getByTestId(index === 0 ? "toggle-server-local" : "toggle-workspace-local-" + index);
}

async function workspaceExpandedState(page, index) {
  const value = await workspaceToggle(page, index).getAttribute("aria-expanded");
  assert.ok(value === "true" || value === "false", `workspace row ${index} must expose aria-expanded`);
  return value;
}

async function assertWorkspaceRowsToggleIndependently(page, context) {
  const indexes = [0, 1];
  const initial = {};
  const current = {};
  for (const index of indexes) {
    const toggle = workspaceToggle(page, index);
    await toggle.waitFor({ state: "visible", timeout: 10_000 });
    await waitFor(() => toggle.isEnabled(), 10_000, `workspace row ${index} to enable collapse`, 50, context.abortSignal);
    initial[index] = await workspaceExpandedState(page, index);
    current[index] = initial[index];
  }

  for (const index of indexes) {
    const toggle = workspaceToggle(page, index);
    const changed = initial[index] === "true" ? "false" : "true";
    await toggle.click();
    await waitFor(
      async () => await workspaceExpandedState(page, index) === changed,
      10_000,
      `workspace row ${index} to change its collapsed state`,
      50,
      context.abortSignal,
    );
    current[index] = changed;
    for (const other of indexes.filter(value => value !== index)) {
      assert.equal(await workspaceExpandedState(page, other), current[other],
        `toggling workspace row ${index} must leave row ${other} unchanged`);
    }
  }

  for (const index of [...indexes].reverse()) {
    const toggle = workspaceToggle(page, index);
    await toggle.click();
    await waitFor(
      async () => await workspaceExpandedState(page, index) === initial[index],
      10_000,
      `workspace row ${index} to restore its initial collapsed state`,
      50,
      context.abortSignal,
    );
    current[index] = initial[index];
    for (const other of indexes.filter(value => value !== index)) {
      assert.equal(await workspaceExpandedState(page, other), current[other],
        `restoring workspace row ${index} must leave row ${other} unchanged`);
    }
  }
  return initial;
}

async function verifyWorkspaceMenuLayout(page, deployment, workspaceIndex, width, height, combo, foldState, rpc, context) {
  const menuId = `workspace-actions-menu-local-${workspaceIndex}`;
  const singleId = `refresh-history-local-${workspaceIndex}`;
  const globalId = `refresh-all-history-local-${workspaceIndex}`;
  await page.getByTestId(`workspace-actions-local-${workspaceIndex}`).click();
  const sheet = page.getByTestId(menuId);
  const singleAction = page.getByTestId(singleId);
  const globalAction = page.getByTestId(globalId);
  await sheet.waitFor({ state: "visible", timeout: 10_000 });
  await singleAction.waitFor({ state: "visible", timeout: 10_000 });
  await globalAction.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await singleAction.isEnabled(), true);
  await waitFor(
    () => globalAction.isEnabled(),
    30_000,
    "current-owner workspace catalog and Home thread loading to settle before enabling all-known-workspaces refresh",
    50,
    context.abortSignal,
  );
  assert.equal(await globalAction.isEnabled(), true, "all-known-workspaces action must be available after catalog settlement");
  await singleAction.click({ trial: true });
  await globalAction.click({ trial: true });

  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, documentWidth: document.documentElement.scrollWidth }));
  assert.equal(viewport.width, width);
  assert.equal(viewport.height, height);
  assert.equal(viewport.documentWidth, width, "workspace action menu must not overflow horizontally");
  const bounds = {
    sheet: await sheet.boundingBox(),
    single: await singleAction.boundingBox(),
    global: await globalAction.boundingBox(),
  };
  for (const [name, box] of Object.entries(bounds)) {
    assert.ok(box, `${name} must have a visible layout box`);
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height,
      `${name} must fit inside the ${width}x${height} viewport`);
  }
  const toggleStateBeforeClose = await workspaceExpandedState(page, workspaceIndex);
  assert.equal(toggleStateBeforeClose, foldState[workspaceIndex], "opening the row menu must not change its fold state");
  await page.screenshot({
    path: context.pathInArtifacts(`after-actions-menu-${width}-${combo.language}-${combo.theme}.png`),
    animations: "disabled",
  });
  await page.getByTestId(`workspace-actions-close-local-${workspaceIndex}`).click();
  await sheet.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(await workspaceExpandedState(page, workspaceIndex), foldState[workspaceIndex],
    "closing the row menu must not change the workspace fold state");
  return {
    deployment: deployment.id,
    language: combo.language,
    theme: combo.theme,
    logicalViewport: { width, height },
    deviceScaleFactor: 2,
    visibleActions: { single: true, allKnownWorkspaces: true },
    actionsEnabled: { single: true, allKnownWorkspaces: true },
    actionsInsideViewport: true,
    noHorizontalOverflow: true,
    foldStatePreserved: true,
  };
}

async function assertPlusRoutesToWorkspace(page, deployment, betaIndex, homeUrl, foldState, rpc, context) {
  const homePath = new URL(page.url()).pathname;
  const expectedHomeUrl = new URL(homeUrl);
  const requestCountBefore = rpc.filter(item =>
    item.deployment === deployment.id &&
    ["thread/start", "turn/start"].includes(item.method),
  ).length;
  await page.getByTestId("new-workspace-local-" + betaIndex).click();
  await page.waitForURL(url => url.pathname === "/mobile/new", { timeout: 20_000 });
  const route = new URL(page.url());
  assert.equal(route.searchParams.get("serverId"), "local");
  const homeProfileId = decodeURIComponent(homePath.split("/").filter(Boolean).at(-1));
  assert.equal(route.searchParams.get("profileId"), homeProfileId);
  assert.equal(resolve(route.searchParams.get("cwd") || ""), resolve(deployment.paths.Beta),
    "the row Plus must route with the clicked Beta workspace cwd");
  const starts = rpc.filter(item =>
    item.deployment === deployment.id &&
    ["thread/start", "turn/start"].includes(item.method),
  );
  assert.equal(starts.length, requestCountBefore, "Plus navigation must not create or send a model task");
  await page.screenshot({
    path: context.pathInArtifacts("after-beta-plus-draft-390-zh-CN-dark.png"),
    animations: "disabled",
  });
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForURL(url => url.pathname === expectedHomeUrl.pathname, { timeout: 20_000 });
  assert.equal(new URL(page.url()).pathname, homePath, "Plus return must reach the same profile Home route");
  await waitForHomeRows(page, context, rpc, deployment.id);
  for (const index of [0, 1]) {
    assert.equal(await workspaceExpandedState(page, index), foldState[index],
      "Plus navigation and return must preserve each workspace fold state");
  }
  return { from: homePath, to: route.pathname, serverId: "local", workspaceAlias: "Beta", routeScopeMatches: true };
}

async function verifySingleWorkspaceAction(page, deployment, betaIndex, homeUrl, rpc, context) {
  const refreshCountBefore = rpc.filter(item =>
    item.deployment === deployment.id && item.method === "thread/history/refresh",
  ).length;
  const rowMore = page.getByTestId("workspace-actions-local-" + betaIndex);
  await rowMore.click();
  const sheet = page.getByTestId("workspace-actions-menu-local-" + betaIndex);
  await sheet.waitFor({ state: "visible", timeout: 10_000 });
  const singleAction = page.getByTestId("refresh-history-local-" + betaIndex);
  const globalAction = page.getByTestId("refresh-all-history-local-" + betaIndex);
  await singleAction.waitFor({ state: "visible", timeout: 10_000 });
  await globalAction.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await globalAction.isEnabled(), true, "global refresh is available after the owner catalog settles");
  await page.screenshot({
    path: context.pathInArtifacts("after-beta-workspace-actions-menu-390-zh-CN-dark.png"),
    animations: "disabled",
  });
  await singleAction.click();
  const dialog = page.getByTestId("history-refresh-dialog");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await page.screenshot({
    path: context.pathInArtifacts("after-beta-refresh-confirmation-390-zh-CN-dark.png"),
    animations: "disabled",
  });
  const start = page.getByTestId("history-refresh-start");
  assert.equal(await start.isEnabled(), false, "single-scope refresh requires explicit acknowledgment");
  await page.getByTestId("history-refresh-close").click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(rpc.filter(item =>
    item.deployment === deployment.id && item.method === "thread/history/refresh",
  ).length, refreshCountBefore, "closing an unconfirmed single-scope dialog must not start a refresh RPC");

  await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
  await waitForHomeRows(page, context, rpc, deployment.id);
  await rowMore.click();
  await page.getByTestId("workspace-actions-menu-local-" + betaIndex).waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("refresh-history-local-" + betaIndex).click();
  await page.getByTestId("history-refresh-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("history-refresh-acknowledge").click();
  assert.equal(await page.getByTestId("history-refresh-start").isEnabled(), true);
  await page.getByTestId("history-refresh-start").click();
  const result = await waitFor(
    () => {
      const calls = rpc.filter(item =>
        item.deployment === deployment.id && item.method === "thread/history/refresh",
      ).slice(refreshCountBefore);
      const starts = calls.filter(item => item.action === "start");
      const ready = calls.filter(item => item.action === "cursor" && item.response?.status === "ready" &&
        item.response?.issueCount === 0 && item.response?.hasNextCursor === false);
      return starts.length === 1 && ready.length === 1 && ready[0].socketOrdinal === starts[0].socketOrdinal
        ? { calls, starts, ready }
        : null;
    },
    45_000,
    "single-workspace build to finish with a same-owner cursor response for Beta",
    50,
    context.abortSignal,
  );
  const newCalls = result.calls;
  const starts = result.starts;
  const finalReady = result.ready;
  assert.equal(starts.length, 1, "single-scope confirmation must issue exactly one acknowledged start");
  assert.equal(starts[0].serverId, "local");
  assert.equal(starts[0].workspaceAlias, "Beta");
  assert.equal(starts[0].params.acknowledgeExternalWriters, true);
  assert.equal(starts[0].response?.status, "building", "a new refresh starts with a building response");
  assert.equal(starts[0].response?.hasNextCursor, true);
  assert.deepEqual(new Set(newCalls.map(item => item.workspaceAlias)), new Set(["Beta"]),
    "single-scope refresh must not send work for another workspace");
  assert.ok(newCalls.every(item => item.serverId === "local"));
  assert.ok(finalReady.every(item => item.response?.issueCount === 0));
  await page.getByTestId("history-refresh-close").click();
  await page.getByTestId("history-refresh-dialog").waitFor({ state: "hidden", timeout: 10_000 });
  return {
    openedFromWorkspaceIndex: betaIndex,
    singleActionVisible: true,
    globalActionAlsoVisibleAndEnabled: true,
    unacknowledgedCloseIssuedNoRefresh: true,
    startRequests: starts.map(summarizeHistoryCall),
    finalReadyReceipts: finalReady.map(summarizeHistoryCall),
    calls: newCalls.map(summarizeHistoryCall),
    allReady: starts.length === 1 && finalReady.length === 1,
  };
}

async function verifyGlobalBatchAction(page, deployment, entryIndex, workspacePaths, homeUrl, rpc, context) {
  const refreshCountBefore = rpc.filter(item =>
    item.deployment === deployment.id && item.method === "thread/history/refresh",
  ).length;
  const rowMore = page.getByTestId("workspace-actions-local-" + entryIndex);
  await rowMore.click();
  const sheet = page.getByTestId("workspace-actions-menu-local-" + entryIndex);
  await sheet.waitFor({ state: "visible", timeout: 10_000 });
  const singleAction = page.getByTestId("refresh-history-local-" + entryIndex);
  const globalAction = page.getByTestId("refresh-all-history-local-" + entryIndex);
  await singleAction.waitFor({ state: "visible", timeout: 10_000 });
  await globalAction.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await globalAction.isEnabled(), true);
  await globalAction.click();
  const dialog = page.getByTestId("history-refresh-dialog");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const scopedRows = page.getByTestId("history-refresh-workspaces");
  await scopedRows.waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await page.getByTestId("history-refresh-workspace-0").count(), 1);
  assert.equal(await page.getByTestId("history-refresh-workspace-1").count(), 1);
  const shownScopes = await Promise.all([0, 1].map(index =>
    page.getByTestId("history-refresh-workspace-" + index).innerText(),
  ));
  assert.deepEqual(
    new Set(shownScopes.map(path => resolve(path.trim()))),
    new Set([resolve(workspacePaths.Alpha), resolve(workspacePaths.Beta)]),
    "global refresh opened from one workspace row must list every known scope on the server",
  );
  await page.screenshot({
    path: context.pathInArtifacts("after-global-refresh-confirmation-390-zh-CN-dark.png"),
    animations: "disabled",
  });
  assert.equal(await page.getByTestId("history-refresh-start").isEnabled(), false);
  await page.getByTestId("history-refresh-close").click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  assert.equal(rpc.filter(item =>
    item.deployment === deployment.id && item.method === "thread/history/refresh",
  ).length, refreshCountBefore, "closing an unconfirmed batch dialog must not start workspace refresh RPCs");

  await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
  await waitForHomeRows(page, context, rpc, deployment.id);
  await rowMore.click();
  await page.getByTestId("workspace-actions-menu-local-" + entryIndex).waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("refresh-all-history-local-" + entryIndex).click();
  await page.getByTestId("history-refresh-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("history-refresh-acknowledge").click();
  assert.equal(await page.getByTestId("history-refresh-start").isEnabled(), true);
  await page.getByTestId("history-refresh-start").click();
  const result = await waitFor(
    () => {
      const calls = rpc.filter(item =>
        item.deployment === deployment.id && item.method === "thread/history/refresh",
      ).slice(refreshCountBefore);
      const starts = calls.filter(item => item.action === "start");
      const aliases = new Set(starts.map(item => item.workspaceAlias));
      if (starts.length !== 2 || !aliases.has("Alpha") || !aliases.has("Beta")) return null;
      const finalReady = starts.map(start => calls.filter(item =>
        item.socketOrdinal === start.socketOrdinal &&
        item.workspaceAlias === start.workspaceAlias &&
        item.action === "cursor" &&
        item.response?.status === "ready" &&
        item.response?.issueCount === 0 &&
        item.response?.hasNextCursor === false,
      ));
      return finalReady.every(receipts => receipts.length === 1) ? { calls, starts, finalReady: finalReady.flat() } : null;
    },
    60_000,
    "global batch to finish each known workspace on its own cursor owner",
    50,
    context.abortSignal,
  );
  const newCalls = result.calls;
  const starts = result.starts;
  const finalReady = result.finalReady;
  assert.equal(starts.length, 2, "global batch must issue exactly one acknowledged start per known workspace");
  assert.deepEqual(new Set(starts.map(item => item.workspaceAlias)), new Set(["Alpha", "Beta"]));
  assert.ok(starts.every(item => item.serverId === "local" && item.params.acknowledgeExternalWriters === true));
  assert.ok(starts.every(item => item.response?.status === "building" && item.response?.hasNextCursor === true));
  assert.deepEqual(new Set(newCalls.map(item => item.workspaceAlias)), new Set(["Alpha", "Beta"]),
    "global refresh must not send work outside the known workspace snapshot");
  assert.ok(newCalls.every(item => item.serverId === "local"));
  assert.equal(finalReady.length, 2);
  assert.ok(finalReady.every(item => item.response?.issueCount === 0));
  const batchProgress = page.getByTestId("history-refresh-batch-progress");
  await batchProgress.waitFor({ state: "visible", timeout: 10_000 });
  const batchProgressText = await waitFor(
    async () => {
      const text = await batchProgress.innerText();
      return /已完成\s*2\s*\/\s*2\s*个工作区/.test(text) || /Completed\s+2\s+of\s+2\s+workspaces/i.test(text)
        ? text
        : null;
    },
    10_000,
    "global batch UI to report both workspaces complete",
    50,
    context.abortSignal,
  );
  await page.screenshot({
    path: context.pathInArtifacts("after-global-refresh-ready-390-zh-CN-dark.png"),
    animations: "disabled",
  });
  await page.getByTestId("history-refresh-close").click();
  await page.getByTestId("history-refresh-dialog").waitFor({ state: "hidden", timeout: 10_000 });
  return {
    openedFromWorkspaceIndex: entryIndex,
    globalActionIncludesEveryKnownWorkspace: true,
    unacknowledgedCloseIssuedNoRefresh: true,
    shownScopes,
    startRequests: starts.map(summarizeHistoryCall),
    finalReadyReceipts: finalReady.map(summarizeHistoryCall),
    calls: newCalls.map(summarizeHistoryCall),
    batchProgressText,
    completedWorkspaces: 2,
    totalWorkspaces: 2,
    allReady: starts.length === 2 && finalReady.length === 2,
  };
}

function summarizeHistoryCall(item) {
  return {
    socketOrdinal: item.socketOrdinal,
    serverId: item.serverId,
    workspaceAlias: item.workspaceAlias,
    params: item.params,
    response: item.response,
  };
}

function observeRpc(page, calls, workspacePaths, { deployment = "unknown", forbiddenModelRequests } = {}) {
  let ordinal = 0;
  const pending = new Map();
  page.on("websocket", socket => {
    const socketOrdinal = ++ordinal;
    let query;
    try {
      const url = new URL(socket.url());
      query = {
        serverId: url.searchParams.get("server"),
        workspacePath: url.searchParams.get("workspace"),
      };
    } catch {
      query = { serverId: null, workspacePath: null };
    }
    socket.on("framesent", event => {
      const frame = parseFrame(event.payload);
      if (!frame || typeof frame.method !== "string") return;
      if (forbiddenModelRequests && ["thread/start", "turn/start"].includes(frame.method)) {
        forbiddenModelRequests.push({ deployment, method: frame.method });
      }
      if (![
        "runtime.workspaces.openV2",
        "runtime.workspaces.list",
        "runtime.worktrees.list",
        "thread/history/refresh",
        "thread/start",
        "turn/start",
      ].includes(frame.method)) return;
      const id = frame.id === undefined ? null : String(frame.id);
      const params = frame.method === "thread/history/refresh"
        ? {
            acknowledgeExternalWriters: frame.params?.acknowledgeExternalWriters === true,
            cancel: frame.params?.cancel === true,
            cursorPresent: typeof frame.params?.cursor === "string",
          }
        : frame.method === "runtime.workspaces.openV2"
          ? { workspacePathAlias: workspaceAlias(workspacePaths, frame.params?.workspacePath) }
          : {};
      const call = {
        deployment,
        socketOrdinal,
        id,
        method: frame.method,
        serverId: query.serverId,
        workspaceAlias: frame.method === "runtime.workspaces.openV2"
          ? params.workspacePathAlias
          : workspaceAlias(workspacePaths, query.workspacePath),
        action: frame.method === "thread/history/refresh"
          ? params.acknowledgeExternalWriters ? "start" : params.cancel ? "cancel" : params.cursorPresent ? "cursor" : "unknown"
          : null,
        params,
        response: null,
      };
      calls.push(call);
      if (id !== null) pending.set(socketOrdinal + ":" + id, call);
    });
    socket.on("framereceived", event => {
      const frame = parseFrame(event.payload);
      if (!frame || frame.id === undefined) return;
      const call = pending.get(socketOrdinal + ":" + String(frame.id));
      if (!call) return;
      pending.delete(socketOrdinal + ":" + String(frame.id));
      if (frame.error) {
        call.response = {
          errorCode: Number.isSafeInteger(frame.error.code) ? frame.error.code : null,
          status: "error",
        };
        return;
      }
      if (call.method === "thread/history/refresh") {
        call.response = {
          status: typeof frame.result?.status === "string" ? frame.result.status : null,
          issueCount: Number.isSafeInteger(frame.result?.issueCount) ? frame.result.issueCount : null,
          examinedEntries: Number.isSafeInteger(frame.result?.examinedEntries) ? frame.result.examinedEntries : null,
          indexedSessions: Number.isSafeInteger(frame.result?.indexedSessions) ? frame.result.indexedSessions : null,
          hasNextCursor: typeof frame.result?.nextCursor === "string",
          errorCode: null,
        };
        return;
      }
      if (call.method === "runtime.workspaces.openV2") {
        const receipt = frame.result?.receipt ?? null;
        const responsePath = receipt?.workspacePath ?? null;
        call.response = {
          errorCode: null,
          workspaceReady: receipt?.status === "ready",
          workspaceMatches: typeof responsePath === "string" &&
            workspaceAlias(workspacePaths, responsePath) === "Beta",
          scopeVersion: frame.result?.scope?.version ?? null,
          receiptIdPresent: typeof receipt?.clientRequestId === "string",
        };
        return;
      }
      call.response = { errorCode: null, status: "success" };
    });
  });
}

function workspaceAlias(paths, path) {
  if (typeof path !== "string" || path.length === 0) return null;
  const normalized = resolve(path);
  for (const [alias, expected] of Object.entries(paths)) {
    if (normalized === resolve(expected)) return alias;
  }
  return "other";
}

function observePage(page, diagnostics, currentPageErrors, deployment) {
  page.on("pageerror", () => {
    diagnostics.push({ deployment, kind: "pageerror" });
    if (deployment === "current") currentPageErrors.push({ kind: "pageerror" });
  });
  page.on("console", message => {
    if (message.type() !== "error") return;
    diagnostics.push({ deployment, kind: "console-error" });
    if (deployment === "current") currentPageErrors.push({ kind: "console-error" });
  });
}

async function captureProvisionFailure(context, page, homePath, stage, rpc = []) {
  if (page.isClosed()) return;
  let pathname;
  try {
    const url = new URL(page.url());
    pathname = url.pathname;
    if (url.searchParams.has("token") || url.searchParams.has("pairingToken") || url.searchParams.has("authorization")) return;
  } catch {
    return;
  }
  if (pathname !== homePath && pathname !== "/mobile/new") return;

  const buttons = await page.locator("button").evaluateAll(elements => {
    const visible = elements.map(button => {
      const rect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      return {
        button,
        rect,
        visible: rect.width > 0 && rect.height > 0 && style.display !== "none" &&
          style.visibility !== "hidden" && Number(style.opacity) > 0,
      };
    }).filter(item => item.visible);
    return {
      totalCount: elements.length,
      visibleCount: visible.length,
      visible: visible.slice(0, 80).map(({ button, rect }) => {
        const ariaLabel = button.getAttribute("aria-label") || "";
        return {
          testId: (button.getAttribute("data-testid") || "").slice(0, 120),
          ariaLabel: /token|password|secret|authorization|bearer/i.test(ariaLabel) ? "[redacted]" : ariaLabel.slice(0, 120),
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }),
    };
  });
  const unavailableReasons = [];
  const unavailableLocators = await page.locator('[data-testid^="refresh-all-history-unavailable-"]').all();
  for (const locator of unavailableLocators) {
    if (!await locator.isVisible().catch(() => false)) continue;
    const value = await locator.innerText().catch(() => "");
    const safe = context.redactText(value.trim()).slice(0, 300);
    if (safe) unavailableReasons.push(safe);
  }
  const visibleAlerts = [];
  const alertLocators = await page.getByRole("alert").all();
  for (const locator of alertLocators) {
    if (!await locator.isVisible().catch(() => false)) continue;
    const value = await locator.innerText().catch(() => "");
    const safe = context.redactText(value.trim()).slice(0, 300);
    if (safe) visibleAlerts.push(safe);
  }
  const relevantRpcStatuses = rpc.filter(item => [
    "runtime.workspaces.openV2",
    "runtime.workspaces.list",
    "runtime.worktrees.list",
    "thread/history/refresh",
  ].includes(item.method)).slice(-80).map(item => ({
    method: item.method,
    serverId: item.serverId,
    workspaceAlias: item.workspaceAlias,
    action: item.action,
    params: item.params,
    response: item.response,
  }));

  let screenshotCaptured = false;
  try {
    await page.screenshot({
      path: context.pathInArtifacts("provision-failure.png"),
      timeout: 5_000,
      animations: "disabled",
    });
    screenshotCaptured = true;
  } catch {
    // Keep the original assertion failure if the owned browser cannot capture a screenshot.
  }
  await context.writeArtifactJson("provision-failure-summary.json", {
    stage,
    pathname,
    screenshotCaptured,
    buttons,
    unavailableReasons,
    visibleAlerts,
    relevantRpcStatuses,
  });
}

async function verifyMountedEntry(context, gateway, root, files, gatewayManifestSha256, artifactName) {
  const entry = files.find(file =>
    file.path.startsWith("_expo/static/js/web/entry-") && file.path.endsWith(".js"),
  );
  assert.ok(entry, "Mobile Web bundle must include an Expo web entry chunk");
  const exportedBytes = await readFile(resolve(root, entry.path));
  assert.equal(sha256(exportedBytes), entry.sha256);
  const expectedMountedBytes = Buffer.from(
    exportedBytes.toString("utf8").replaceAll(MOBILE_WEB_BASE_TOKEN, "/mobile"),
  );
  const expectedMountedSha256 = sha256(expectedMountedBytes);
  const response = await fetch(new URL("/mobile/" + entry.path, gateway.baseUrl), {
    signal: AbortSignal.timeout(10_000),
  });
  const servedBytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, "Gateway must serve the actual mounted Mobile Web entry");
  assert.equal(sha256(servedBytes), expectedMountedSha256);
  await context.writeArtifactJson(artifactName, {
    path: entry.path,
    status: response.status,
    exportSha256: entry.sha256,
    expectedMountedSha256,
    servedSha256: sha256(servedBytes),
    matchesDeployTransform: true,
    gatewayManifestSha256,
  });
}

function parseFrame(payload) {
  try {
    return JSON.parse(String(payload));
  } catch {
    return null;
  }
}

function ownedContextCleanup(context, label, browserContext) {
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await browserContext.close();
  };
  context.addCleanup(label, close);
  return close;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
