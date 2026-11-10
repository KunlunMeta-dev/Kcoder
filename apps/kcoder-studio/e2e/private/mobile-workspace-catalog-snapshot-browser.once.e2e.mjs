// Private, one-shot browser acceptance for the frozen Mobile workspace catalog.
// Run "export" first; run "browser" only after independent static review.
// This proves mounted Mobile Web + JS mock Gateway behavior, not Rust/native/provider behavior.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { verifyMobileExportManifestEnvelope } from "../harness/mobile-web-export-input.mjs";
import { reuseMobileWebExport } from "../harness/mobile-web-export-reuse.mjs";
import { appRoot, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { buildExpoExportArguments } from "../harness/render-profile-attribution-contract.mjs";

const EXPECTED_REPO_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/worktree/2026/10/09/mobile-ux-followup-20261009";
const EXPECTED_NODE_PATH = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const EXPECTED_DEPENDENCY_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/apps/kcoder-studio/mobile/node_modules";
const EXPECTED_CHROMIUM_PATH = "/opt/cft/chrome-linux64/chrome";
const EXPECTED_CHROMIUM_VERSION = "151.0.7922.34";
const EXPECTED_CHROMIUM_SHA256 = "0b20b130e7edd9dd51873be867761295fe0cfad490c2b9a64f95bd3cfc08fa71";
const EXPECTED_FREEZE_EVIDENCE_SHA256 = "8b0b6fda529890f9a8e16edf45363464a7f710765bc7f4411b76ba2a31e3abf3";
const EXPECTED_HEAD = "2ad3474ceaad33646cc7b4fee7b03934f1bb9c79";
const NODE_VERSION = "v22.17.0";
const FROZEN_PRODUCT_PATHS = Object.freeze([
  "apps/kcoder-studio/mobile/src/runtime/task-runtime/workspaces.ts",
  "apps/kcoder-studio/mobile/src/app/open-project.tsx",
  "apps/kcoder-studio/mobile/src/runtime/task-runtime.catalog-snapshot-v1.review.test.ts",
]);
const EXPORT_SUPPORT_PATHS = Object.freeze([
  "apps/kcoder-studio/mobile/package-lock.json",
  "apps/kcoder-studio/dev-server.mjs",
  "apps/kcoder-studio/src/mobile-web-static.js",
  "apps/kcoder-studio/e2e/harness/mobile-web-export.mjs",
  "apps/kcoder-studio/e2e/harness/mobile-web-export-input.mjs",
  "apps/kcoder-studio/e2e/harness/mobile-web-export-reuse.mjs",
  "apps/kcoder-studio/e2e/harness/run-context.mjs",
]);
const BROWSER_SUPPORT_PATHS = Object.freeze([
  ...EXPORT_SUPPORT_PATHS,
  "apps/kcoder-studio/e2e/harness/gateway.mjs",
  "apps/kcoder-studio/e2e/harness/chromium.mjs",
]);
const FIXTURE = Object.freeze({
  workspacePath: "/tmp/mobile-catalog-browser/workspace",
  worktreePath: "/tmp/mobile-catalog-browser/worktree",
  worktreeId: "catalog-browser-worktree",
});
const CATALOG_METHODS = new Set([
  "runtime.workspaces.list",
  "runtime.worktrees.list",
]);

assert.equal(resolve(repoRoot), EXPECTED_REPO_ROOT, "this one-shot candidate is scoped to F");
assert.equal(resolve(appRoot), resolve(EXPECTED_REPO_ROOT, "apps/kcoder-studio"));
assert.equal(process.version, NODE_VERSION, "the candidate requires fixed Node 22.17.0");
assert.equal(await realpath(process.execPath), EXPECTED_NODE_PATH, "the candidate requires the fixed Node 22.17.0 binary");

const [phase, ...rawOptions] = process.argv.slice(2);
const options = parseOptions(rawOptions);
assert.ok(phase === "export" || phase === "browser", "usage: <node> <script> export|browser <options>");
const scriptPath = resolve(fileURLToPath(import.meta.url));

if (phase === "export") {
  await runE2E(import.meta.url, {
    testId: "mobile-workspace-catalog-snapshot-export",
    tier: "manual-live",
    modelPolicy: "frozen current Mobile/shared source export; no Gateway, Browser, Provider, or native runtime",
    retainSuccessLogs: true,
  }, async context => {
    const dependencyRoot = requiredOption(options, "dependency-root");
    assert.equal(await realpath(resolve(dependencyRoot)), EXPECTED_DEPENDENCY_ROOT,
      "use the read-only real dependency tree resolved from F Mobile node_modules");
    const freeze = await readFreezeEvidence();
    const pins = await readCurrentPins(freeze.productPins, "export");
    const dependencyMetadata = await readDependencyMetadata(dependencyRoot);

    const exported = await exportMobileWeb(context, {
      mobileRoot: resolve(repoRoot, "apps/kcoder-studio/mobile"),
      sourceRoots: [
        {
          name: "mobile",
          path: resolve(repoRoot, "apps/kcoder-studio/mobile"),
          destination: "apps/kcoder-studio/mobile",
        },
        {
          name: "studio-shared",
          path: resolve(repoRoot, "apps/kcoder-studio/shared"),
          destination: "apps/kcoder-studio/shared",
        },
      ],
      dependencyRoot,
      label: "workspace-catalog-frozen-mobile",
      outputName: "workspace-catalog-mobile-web",
      stateNamespace: "workspace-catalog-export",
      sourceMaps: false,
      deployMount: true,
      timeoutMs: 10 * 60_000,
    });
    assert.equal(exported.buildInputTreeSha256, exported.sourceTreeSha256,
      "exporter copy must be byte-identical to the current Mobile/shared source tree");
    assert.ok(exported.bundleFileCount > 0);
    assert.match(exported.bundleSha256, /^[a-f0-9]{64}$/);

    const bundleArtifactPath = context.pathInArtifacts("mobile-web-bundle");
    await mkdir(bundleArtifactPath, { recursive: false, mode: 0o700 });
    await cp(exported.path, bundleArtifactPath, { recursive: true, errorOnExist: true, force: false });
    const copiedBundleRows = await collectBundleRows(bundleArtifactPath);
    assert.deepEqual(copiedBundleRows, exported.bundleFiles, "retained bundle copy must exactly match exporter inventory");
    assert.equal(hashJson(copiedBundleRows), exported.bundleSha256, "retained bundle digest must match exporter digest");
    await access(resolve(bundleArtifactPath, "index.html"));
    await access(resolve(bundleArtifactPath, "kcoder-mobile-web.json"));

    const exporterManifestBytes = await readFile(exported.bundleManifestPath);
    const exporterManifest = JSON.parse(exporterManifestBytes.toString("utf8"));
    assert.equal(exporterManifest.status, "complete");
    assert.equal(exporterManifest.deployMount, true);
    verifyMobileExportManifestEnvelope(
      exporterManifest,
      exporterManifestBytes,
      sha256(exporterManifestBytes),
      "current frozen workspace catalog",
    );
    assert.equal(exporterManifest.dependencyProvenance.sourceUnchanged, true,
      "the installed dependency source tree must remain unchanged across export");
    assert.equal(
      exporterManifest.dependencyProvenance.sourceTreeSha256Before,
      exporterManifest.dependencyProvenance.sourceTreeSha256After,
      "dependency source-before and source-after must use the same exporter hash algorithm and match",
    );
    assert.match(exporterManifest.dependencyProvenance.copiedTreeSha256 ?? "", /^[a-f0-9]{64}$/,
      "the dereferenced owned dependency copy digest must be present");
    assert.equal(exported.bundleFileCount, 37, "the public Mobile Web bundle must contain the standard 37 resources");
    const retainedManifestPath = await context.writeArtifactJson("mobile-workspace-catalog-retained-export.json", {
      schemaVersion: 1,
      purpose: "current frozen Mobile workspace catalog browser acceptance",
      sourceCommit: context.gitCommit,
      sourceTreeSha256: exported.sourceTreeSha256,
      bundleSha256: exported.bundleSha256,
      bundleFileCount: exported.bundleFileCount,
      indexHtmlSha256: exported.indexHtmlSha256,
      directory: relative(context.runRoot, bundleArtifactPath).split(sep).join("/"),
      files: exported.bundleFiles,
    });
    const retainedManifestSha256 = sha256(await readFile(retainedManifestPath));
    const finalSupportPins = await readSupportPins(EXPORT_SUPPORT_PATHS);
    assert.deepEqual(finalSupportPins, pins.support,
      "exporter/Gateway source pins changed while the current candidate was being exported");
    assert.equal(await sha256File(scriptPath), pins.testSourceSha256,
      "the one-shot E2E source changed while the current candidate was being exported");
    const nodePin = await binaryPin(process.execPath, process.version);
    const exportArgv = buildExpoExportArguments(
      resolve(context.stateDir, "workspace-catalog-export/mobile-build-source/apps/kcoder-studio/mobile/node_modules/expo/bin/cli"),
      exported.path,
      false,
    );
    const artifact = {
      schemaVersion: 1,
      phase: "export",
      status: "PASS",
      evidenceClass: "current frozen Mobile Web source exported by the harness; no Browser/Gateway/Provider",
      argv: process.argv,
      cwd: process.cwd(),
      node: nodePin,
      source: {
        headFromFreezeEvidence: freeze.head,
        runContextHead: context.gitCommit,
        headRelationship: "RunContext HEAD may include unrelated commits; source identity is established by the pinned verification.json, its three product file hashes, and exporter full Mobile/shared content digest",
        freezeEvidencePath: freeze.path,
        freezeEvidenceSha256: freeze.sha256,
        productFilePins: pins.product,
        testSourceSha256: pins.testSourceSha256,
        sourceTreeSha256: exported.sourceTreeSha256,
        inputRoots: exported.sourceRoots,
        reviewTestIsIncludedInMobileSourceRoot: true,
        freezeValidation: freeze.validation,
        reviewTestStatusAtHead: freeze.reviewTestStatusAtHead,
      },
      dependencies: {
        root: exported.dependencyRoot,
        sourceTreeSha256: exported.dependencySourceTreeSha256,
        ownedTreeSha256: exported.dependencyOwnedTreeSha256,
        lockSha256: pins.support["apps/kcoder-studio/mobile/package-lock.json"],
        expoVersion: dependencyMetadata.expoVersion,
        expoPackageJsonSha256: dependencyMetadata.expoPackageJsonSha256,
        sourceTreeSha256WasCheckedBeforeAndAfterWithExporterAlgorithm: true,
        hashDefinitions: {
          sourceTree: "exportMobileWeb collectTree with includeNodeModules=true; symlink entries hash link targets",
          ownedTree: "exportMobileWeb hashes the cp -aL dereferenced copy with rejectSymlinks=true",
          sourceAndOwnedHashesAreRecordedSeparately: true,
          sourceAndOwnedHashesAreNotAssertedEqual: true,
          sourceBeforeEqualsSourceAfter: exporterManifest.dependencyProvenance.sourceUnchanged,
          sourceBeforeSha256: exporterManifest.dependencyProvenance.sourceTreeSha256Before,
          sourceAfterSha256: exporterManifest.dependencyProvenance.sourceTreeSha256After,
          dereferencedOwnedSha256: exporterManifest.dependencyProvenance.copiedTreeSha256,
        },
      },
      export: {
        sourceTreeSha256: exported.sourceTreeSha256,
        bundleSha256: exported.bundleSha256,
        bundleFileCount: exported.bundleFileCount,
        indexHtmlSha256: exported.indexHtmlSha256,
        deployMount: true,
        sourceMaps: false,
        retainedBundlePath: bundleArtifactPath,
        retainedManifestPath,
        retainedManifestSha256,
        exporterManifestPath: exported.bundleManifestPath,
        exporterManifestSha256: sha256(exporterManifestBytes),
        processPids: {
          dependencyCopy: exported.dependencyCopierPid,
          terminalHtmlBuild: exported.terminalBuilderPid,
          expoExport: exported.exporterPid,
        },
        argv: {
          dependencyCopy: [
            "cp",
            "-aL",
            "--reflink=auto",
            exported.dependencyRoot + "/.",
            resolve(context.stateDir, "workspace-catalog-export/mobile-build-source/apps/kcoder-studio/mobile/node_modules") + "/",
          ],
          terminalHtmlBuild: [
            process.execPath,
            resolve(context.stateDir, "workspace-catalog-export/mobile-build-source/apps/kcoder-studio/mobile/scripts/build-terminal-webview.mjs"),
          ],
          expoExport: [process.execPath, ...exportArgv],
        },
        timingBoundary: "the export manifest records build phase timestamps; no browser RTT or performance claim",
      },
      supportingSourcePins: pins.support,
      credentialHandling: "Gateway token is not created in export phase; no environment is captured",
    };
    const artifactPath = await context.writeArtifactJson("mobile-workspace-catalog-export.json", artifact);
    return {
      artifactPath,
      artifactSha256: sha256(await readFile(artifactPath)),
      bundleArtifactPath,
      bundleSha256: exported.bundleSha256,
      sourceTreeSha256: exported.sourceTreeSha256,
      dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
      processPids: artifact.export.processPids,
    };
  });
} else {
  await runE2E(import.meta.url, {
    testId: "mobile-workspace-catalog-snapshot-mounted-browser",
    tier: "manual-live",
    modelPolicy: "real mounted Mobile Web UI on isolated KCODER_STUDIO_MOCK JavaScript Gateway with browser-bridge directory fixtures; no Rust app-server, Provider/model, Android, or iOS evidence",
    retainSuccessLogs: true,
  }, async context => {
    const exportManifestPath = resolve(requiredOption(options, "export-manifest"));
    const expectedExportManifestSha256 = requireSha(requiredOption(options, "export-manifest-sha256"), "export manifest SHA-256");
    const exportBytes = await readFile(exportManifestPath);
    assert.equal(sha256(exportBytes), expectedExportManifestSha256, "export handoff manifest does not match its explicit pin");
    const exportArtifact = JSON.parse(exportBytes.toString("utf8"));
    assert.equal(exportArtifact.phase, "export");
    assert.equal(exportArtifact.status, "PASS");
    assert.equal(exportArtifact.export.deployMount, true);
    const freeze = await readFreezeEvidence();
    assert.equal(freeze.sha256, exportArtifact.source.freezeEvidenceSha256,
      "browser phase must use the same hash-pinned source freeze evidence as export");
    const pins = await readCurrentPins(freeze.productPins, "browser");
    assert.deepEqual(pins.product, exportArtifact.source.productFilePins,
      "frozen Mobile product source changed after export");
    assert.equal(pins.testSourceSha256, exportArtifact.source.testSourceSha256,
      "the E2E candidate source changed between export and browser phases");
    for (const [path, sha256Value] of Object.entries(exportArtifact.supportingSourcePins)) {
      assert.equal(pins.support[path], sha256Value,
        "exporter support source changed after export: " + path);
    }
    const exporterManifestBytes = await readFile(exportArtifact.export.exporterManifestPath);
    assert.equal(sha256(exporterManifestBytes), exportArtifact.export.exporterManifestSha256);
    verifyMobileExportManifestEnvelope(
      JSON.parse(exporterManifestBytes.toString("utf8")),
      exporterManifestBytes,
      exportArtifact.export.exporterManifestSha256,
      "browser input frozen export",
    );
    const retainedManifestPath = resolve(exportArtifact.export.retainedManifestPath);
    const retainedManifestBytes = await readFile(retainedManifestPath);
    assert.equal(sha256(retainedManifestBytes), exportArtifact.export.retainedManifestSha256);
    const retainedManifest = JSON.parse(retainedManifestBytes.toString("utf8"));
    assert.equal(retainedManifest.sourceTreeSha256, exportArtifact.source.sourceTreeSha256);
    assert.equal(retainedManifest.bundleSha256, exportArtifact.export.bundleSha256);
    const mobileWeb = await reuseMobileWebExport(context, {
      bundleRoot: resolve(exportArtifact.export.retainedBundlePath),
      manifestPath: retainedManifestPath,
      expectedSourceTreeSha256: exportArtifact.source.sourceTreeSha256,
      expectedManifestSha256: exportArtifact.export.retainedManifestSha256,
      expectedBundleSha256: exportArtifact.export.bundleSha256,
      expectedBundleFileCount: exportArtifact.export.bundleFileCount,
      label: "current-frozen-workspace-catalog",
      outputName: "owned-current-workspace-catalog-mobile-web",
    });
    assert.equal(mobileWeb.exportPerformed, false);
    assert.equal(mobileWeb.bundleSha256, exportArtifact.export.bundleSha256);
    const bundleRoot = mobileWeb.path;

    const workspaceRoot = context.pathInState("mock-workspace");
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    const serversFile = await context.writeStateJson("mock-servers.json", [{
      id: "catalog-fixture",
      label: "Catalog fixture",
      runtime: "kcoder",
      transport: "local",
      command: process.execPath,
      workspace: workspaceRoot,
    }]);
    const serversStore = context.pathInState("gateway-servers-store.json");
    const gateway = await startGateway(context, {
      auth: true,
      label: "mobile-catalog-js-mock-gateway",
      workspace: workspaceRoot,
      serversFile,
      serversStore,
      kcoderBin: process.execPath,
      env: {
        KCODER_STUDIO_MOCK: "1",
        KCODER_STUDIO_WEB_ROOT: "",
        KCODER_STUDIO_MOBILE_WEB_ROOT: bundleRoot,
      },
    });
    const entryResponse = await fetch(gateway.baseUrl + "/mobile-entry");
    assert.equal(entryResponse.status, 200, "the owned Gateway must expose its Mobile mount entry");
    const entry = await entryResponse.json();
    assert.equal(entry.available, true);
    assert.equal(entry.mobileUrl, gateway.baseUrl + "/mobile/");
    const mountResponse = await fetch(gateway.baseUrl + "/mobile/");
    assert.equal(mountResponse.status, 200, "the actual Gateway /mobile/ mount must serve the current candidate");

    const chromium = await startChromium(context, {
      label: "mobile-catalog-cft-chromium",
      executablePath: EXPECTED_CHROMIUM_PATH,
      noSandbox: true,
    });
    const browserVersion = chromium.browser.version();
    const chromiumPin = await binaryPin(chromium.executablePath, browserVersion);
    assert.equal(chromiumPin.realPath, EXPECTED_CHROMIUM_PATH, "Chromium must use the fixed CFT executable path");
    assert.equal(browserVersion, EXPECTED_CHROMIUM_VERSION, "Chromium version must match the fixed CFT pin");
    assert.equal(chromiumPin.sha256, EXPECTED_CHROMIUM_SHA256, "Chromium executable must match the fixed CFT SHA-256 pin");
    const requestLedgers = [];
    const browserErrors = [];
    const cases = [];

    try {
      for (const scenario of ["visible-snapshot", "leave-while-pending"]) {
        const page = await chromium.newPage({
          viewport: { width: 390, height: 844 },
          locale: "zh-CN",
        });
        const bridge = installCatalogBridge(page, context, scenario);
        await page.routeWebSocket("**/rpc*", bridge.route);
        const pageErrorListener = error => browserErrors.push({
          scenario,
          kind: "pageerror",
          message: context.redactText(error.message).slice(0, 1000),
        });
        page.on("pageerror", pageErrorListener);
        let caseRecord = { scenario, status: "running" };
        try {
          const mounted = await page.goto(gateway.baseUrl + "/mobile/", { waitUntil: "domcontentloaded" });
          assert.equal(mounted?.status(), 200);
          assert.equal(new URL(page.url()).pathname.startsWith("/mobile/"), true,
            "browser must remain on the Gateway /mobile/ mount");
          await connectDirectly(page, gateway);
          await page.getByTestId("new-workspace").click();
          const openProject = page.getByTestId("open-project-route");
          await openProject.waitFor({ state: "visible", timeout: 30_000 });
          const openProjectWasVisible = await openProject.isVisible();

          if (scenario === "visible-snapshot") {
            await bridge.waitForResponses("injected", 20_000);
            await page.getByText("Catalog workspace", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
            await page.getByText(FIXTURE.workspacePath, { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
            await page.getByTestId("managed-worktrees-section").waitFor({ state: "visible", timeout: 10_000 });
            await page.getByTestId("managed-worktree-" + FIXTURE.worktreeId).waitFor({ state: "visible", timeout: 10_000 });
            await page.getByText("Catalog browser worktree", { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
            await page.getByText(FIXTURE.worktreePath, { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
            // The artificial 300ms response hold lets the cold duplicate-request ledger settle.
            // It is not a network RTT, a user-visible latency measurement, or a timing sample.
            await page.waitForTimeout(400);
            const summary = bridge.summary();
            assertColdCatalogCounts(summary);
            assert.equal(openProjectWasVisible, true);
            caseRecord = {
              scenario,
              status: "PASS",
              pageRouteVisible: true,
              visibleWorkspaceLabel: "Catalog workspace",
              visibleWorkspacePath: FIXTURE.workspacePath,
              visibleWorktreeLabel: "Catalog browser worktree",
              visibleWorktreePath: FIXTURE.worktreePath,
              visibleManagedWorktreeCard: "managed-worktree-" + FIXTURE.worktreeId,
              requestCounts: summary.methodCounts,
              catalogSocketIds: summary.catalogSocketIds,
              connectorCountOnColdCatalogRoute: summary.catalogSocketIds.length,
              initializeCountOnCatalogSocket: summary.catalogInitializeCount,
              artificialResponseHoldMs: 300,
              timingBoundary: "fixture visibility and exact RPC counts only; 300ms is an artificial bridge response hold, not RTT or latency evidence",
            };
          } else {
            await bridge.waitForResponses("suppressed", 20_000);
            const heldBeforeLeave = bridge.summary();
            assert.equal(heldBeforeLeave.catalogSuppressedCount, 2,
              "both original Gateway catalog responses must be suppressed and held");
            assert.equal(heldBeforeLeave.catalogInjectedCount, 0,
              "no browser fixture response may be released before route departure");
            await openProject.getByRole("button").first().click();
            await openProject.waitFor({ state: "hidden", timeout: 10_000 });
            const departed = await waitFor(
              () => bridge.summary().catalogSocketClosedByClient,
              5_000,
              "the Open Project owned catalog transport to close after route departure",
              20,
              context.abortSignal,
            );
            assert.equal(departed, true);
            const afterLeave = bridge.summary();
            assert.equal(afterLeave.catalogDiscardedOnCloseCount, 2,
              "held catalog replies must be discarded when the route-owned transport closes");
            assert.equal(afterLeave.catalogInjectedCount, 0,
              "a cancelled route must receive no late synthetic catalog response");
            assert.equal(afterLeave.catalogSocketClosedByGateway, true,
              "the peer end of the owned browser transport must also close");
            caseRecord = {
              scenario,
              status: "PASS",
              pageRouteVisible: true,
              routeDepartureVisible: true,
              clientTransportClosedBeforeTestPageCleanup: true,
              gatewayTransportClosedBeforeTestPageCleanup: true,
              originalGatewayCatalogResponsesSuppressed: afterLeave.catalogSuppressedCount,
              heldResponsesDiscardedOnOwnedClose: afterLeave.catalogDiscardedOnCloseCount,
              fixtureResponsesAfterLeave: afterLeave.catalogInjectedCount,
              requestCounts: afterLeave.methodCounts,
              catalogSocketIds: afterLeave.catalogSocketIds,
              timingBoundary: "responses were held until UI navigation and discarded on route-owned close; elapsed time is not a latency result",
            };
          }
          requestLedgers.push(bridge.ledger());
          cases.push(caseRecord);
        } catch (error) {
          caseRecord = {
            ...caseRecord,
            status: "FAIL",
            errorName: error?.name ?? "Error",
            error: context.redactText(error?.message ?? String(error)).slice(0, 2000),
            ledger: bridge.ledger(),
          };
          requestLedgers.push(bridge.ledger());
          cases.push(caseRecord);
          throw error;
        } finally {
          await page.close().catch(() => undefined);
          page.off("pageerror", pageErrorListener);
        }
      }
    } finally {
      const sourcePinRows = await readCurrentPins(freeze.productPins, "browser");
      assert.deepEqual(sourcePinRows.product, exportArtifact.source.productFilePins,
        "frozen Mobile product source changed before browser evidence was written");
      assert.equal(sourcePinRows.testSourceSha256, exportArtifact.source.testSourceSha256,
        "the E2E candidate source changed while the browser scenario was running");
      const gatewayArgv = gateway.child.spawnargs?.map(value => context.redactText(String(value))) ?? null;
      const chromiumArgv = chromium.child.spawnargs?.map(value => context.redactText(String(value))) ?? null;
      const browserEvidence = {
        schemaVersion: 1,
        phase: "browser",
        status: cases.length === 2 && cases.every(item => item.status === "PASS") ? "PASS" : "PARTIAL_OR_FAIL",
        evidenceClass: "real mounted Mobile Web browser plus owned KCODER_STUDIO_MOCK JavaScript Gateway and browser-bridge directory fixtures",
        argv: process.argv,
        node: await binaryPin(process.execPath, process.version),
        chromium: {
          executablePath: chromium.executablePath,
          realPath: await realpath(chromium.executablePath),
          version: browserVersion,
          executableSha256: chromiumPin.sha256,
          launchArgv: chromiumArgv,
        },
        gateway: {
          mode: "KCODER_STUDIO_MOCK=1",
          basePath: "/mobile/",
          entryUrlPath: "/mobile-entry",
          mobileWebRoot: bundleRoot,
          launchArgv: gatewayArgv,
          port: gateway.port,
          authCredentialRecorded: false,
          authCredentialRegisteredForRedaction: true,
          rustAppServerUsed: false,
          providerConfiguredOrInvoked: false,
          nativePlatformUsed: false,
        },
        source: {
          headFromFreezeEvidence: freeze.head,
          runContextHead: context.gitCommit,
          headRelationship: "RunContext HEAD may include unrelated commits; source identity is established by the pinned verification.json, its three product file hashes, and exporter full Mobile/shared content digest",
          exportManifestPath,
          exportManifestSha256: expectedExportManifestSha256,
          sourceTreeSha256: exportArtifact.source.sourceTreeSha256,
          currentProductPins: sourcePinRows.product,
          exportProductPins: exportArtifact.source.productFilePins,
          supportingSourcePins: sourcePinRows.support,
          bundleSha256: exportArtifact.export.bundleSha256,
        },
        dependencies: {
          mobileTreeSha256: exportArtifact.dependencies.sourceTreeSha256,
          mobileOwnedTreeSha256: exportArtifact.dependencies.ownedTreeSha256,
          mobileLockSha256: exportArtifact.dependencies.lockSha256,
          expoVersion: exportArtifact.dependencies.expoVersion,
          playwrightPackage: await playwrightPackagePin(),
        },
        cases,
        requestLedger: requestLedgers,
        browserErrors,
        limitations: [
          "The browser bridge forwards each catalog request to the owned JavaScript mock Gateway, suppresses its original directory response, and returns a synthetic directory fixture with the same JSON-RPC id.",
          "The workspace/worktree directory values shown in the UI are browser-bridge fixtures, not directory results implemented or returned by the Gateway.",
          "The artificial 300ms visible-snapshot response hold is only a request-count observation aid; it is not RTT, P95, or an N=1 latency result.",
          "This is not Rust app-server, Provider/model, Android, or iOS evidence.",
          "Shared-waiter ownership is not claimed from browser behavior; any proof is separate Mobile unit-test evidence.",
        ],
        cleanupExpectation: [
          "Gateway and Chromium were started through RunContext-owned helpers.",
          "RunContext manifest records exact PIDs/process groups and final cleanup status.",
          "No screenshot, video, trace, raw URL query, WebSocket auth token, cookie, or process environment is stored.",
        ],
      };
      await context.writeArtifactJson("mobile-workspace-catalog-browser.json", browserEvidence);
      await context.writeArtifactJson("mobile-workspace-catalog-request-ledger.json", {
        schemaVersion: 1,
        redaction: "No raw URLs, cookies, auth tokens, frame bodies, device IDs, or environment are retained.",
        responses: "Gateway request forwarded; original directory response suppressed; browser fixture response separately recorded.",
        cases: requestLedgers,
      });
    }
  });
}

async function connectDirectly(page, gateway) {
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

function installCatalogBridge(page, context, scenario) {
  const sockets = [];
  const events = [];
  const listeners = new Set();
  let nextSocketId = 1;
  const mode = scenario === "leave-while-pending" ? "hold-until-route-close" : "inject-after-300ms";
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const record = (socket, event) => {
    const safe = { elapsedMs: Date.now() - startedAt, socketId: socket.id, ...event };
    events.push(safe);
    socket.events.push(safe);
    if (events.length > 600) events.shift();
    notify();
  };
  const startedAt = Date.now();

  const route = routed => {
    const socket = {
      id: "rpc-" + String(nextSocketId++),
      path: safeSocketPath(routed),
      channel: safeSocketChannel(routed),
      requestsByMethod: {},
      initializeCount: 0,
      catalogRequestsByMethod: {},
      pendingRequests: new Map(),
      heldResponses: new Map(),
      events: [],
      clientClosed: false,
      gatewayClosed: false,
    };
    sockets.push(socket);
    const upstream = routed.connectToServer();
    routed.onMessage(raw => {
      if (typeof raw !== "string") {
        record(socket, { kind: "request-forwarded", method: "[binary]" });
        upstream.send(raw);
        return;
      }
      const frame = parseFrame(raw);
      if (!frame || typeof frame.method !== "string") {
        record(socket, { kind: "request-forwarded", method: "[unparsed]" });
        upstream.send(raw);
        return;
      }
      const method = frame.method;
      socket.requestsByMethod[method] = (socket.requestsByMethod[method] ?? 0) + 1;
      if (method === "initialize") socket.initializeCount += 1;
      if (CATALOG_METHODS.has(method)) {
        socket.catalogRequestsByMethod[method] = (socket.catalogRequestsByMethod[method] ?? 0) + 1;
      }
      if (Object.hasOwn(frame, "id")) {
        socket.pendingRequests.set(rpcIdKey(frame.id), {
          id: frame.id,
          method,
          requestFingerprint: fingerprint(frame.id),
        });
      }
      record(socket, {
        kind: "request-forwarded",
        method: safeMethod(method),
        requestIdFingerprint: Object.hasOwn(frame, "id") ? fingerprint(frame.id) : null,
        to: "owned-js-mock-gateway",
      });
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      if (typeof raw !== "string") {
        record(socket, { kind: "gateway-response-forwarded", method: "[binary]" });
        routed.send(raw);
        return;
      }
      const frame = parseFrame(raw);
      if (!frame || !Object.hasOwn(frame, "id") || Object.hasOwn(frame, "method")) {
        record(socket, { kind: "gateway-message-forwarded", method: frame?.method ? safeMethod(frame.method) : "[unparsed]" });
        routed.send(raw);
        return;
      }
      const key = rpcIdKey(frame.id);
      const request = socket.pendingRequests.get(key);
      if (!request || !CATALOG_METHODS.has(request.method)) {
        if (request) socket.pendingRequests.delete(key);
        record(socket, {
          kind: "gateway-response-forwarded",
          method: safeMethod(request?.method ?? "[unmatched]"),
          requestIdFingerprint: fingerprint(frame.id),
        });
        routed.send(raw);
        return;
      }

      socket.pendingRequests.delete(key);
      const held = {
        key,
        id: frame.id,
        method: request.method,
        requestIdFingerprint: request.requestFingerprint,
        originalGatewayShape: Object.hasOwn(frame, "error") ? "error" : "result",
        timer: null,
      };
      socket.heldResponses.set(key, held);
      record(socket, {
        kind: "gateway-response-suppressed",
        method: safeMethod(request.method),
        requestIdFingerprint: request.requestFingerprint,
        originalGatewayShape: held.originalGatewayShape,
        browserResponse: "held",
      });
      if (mode === "inject-after-300ms") {
        held.timer = setTimeout(() => injectFixture(socket, held, routed, record), 300);
      }
    });
    routed.onClose(() => {
      socket.clientClosed = true;
      record(socket, { kind: "client-websocket-closed", closeSide: "browser" });
      discardHeld(socket, record);
    });
    upstream.onClose(() => {
      socket.gatewayClosed = true;
      record(socket, { kind: "gateway-websocket-closed", closeSide: "gateway" });
      discardHeld(socket, record);
    });
    routed.onError(() => record(socket, { kind: "client-websocket-error", error: "redacted" }));
    upstream.onError(() => record(socket, { kind: "gateway-websocket-error", error: "redacted" }));
  };

  return {
    route,
    waitForResponses(kind, timeoutMs) {
      return waitFor(() => {
        const summary = summarize(sockets);
        if (kind === "injected") return summary.catalogInjectedCount >= 2;
        if (kind === "suppressed") return summary.catalogSuppressedCount >= 2;
        return false;
      }, timeoutMs, "browser bridge catalog responses " + kind, 20, context.abortSignal);
    },
    summary() {
      return summarize(sockets);
    },
    ledger() {
      const summary = summarize(sockets);
      return {
        scenario,
        mode,
        artificialResponseHoldMs: mode === "inject-after-300ms" ? 300 : null,
        globalMethodCounts: summary.methodCounts,
        catalogSocketIds: summary.catalogSocketIds,
        catalogRequestCounts: summary.catalogRequestCounts,
        catalogSuppressedCount: summary.catalogSuppressedCount,
        catalogInjectedCount: summary.catalogInjectedCount,
        catalogDiscardedOnCloseCount: summary.catalogDiscardedOnCloseCount,
        catalogSocketClosedByClient: summary.catalogSocketClosedByClient,
        catalogSocketClosedByGateway: summary.catalogSocketClosedByGateway,
        sockets: sockets.map(socket => ({
          id: socket.id,
          path: socket.path,
          channel: socket.channel,
          requestsByMethod: socket.requestsByMethod,
          initializeCount: socket.initializeCount,
          catalogRequestsByMethod: socket.catalogRequestsByMethod,
          clientClosed: socket.clientClosed,
          gatewayClosed: socket.gatewayClosed,
        })),
        events,
      };
    },
  };
}

function injectFixture(socket, held, routed, record) {
  if (!socket.heldResponses.has(held.key) || socket.clientClosed || socket.gatewayClosed) {
    discardOne(socket, held, record, "transport-closed-before-fixture");
    return;
  }
  socket.heldResponses.delete(held.key);
  const jsonrpc = "2.0";
  const response = {
    jsonrpc,
    id: held.id,
    result: fixtureResultsForMethod(held.method),
  };
  record(socket, {
    kind: "browser-fixture-response-injected",
    method: safeMethod(held.method),
    requestIdFingerprint: held.requestIdFingerprint,
    from: "browser-bridge-fixture",
    sameJsonRpcIdAsRequest: true,
    originalGatewayResponseWasSuppressed: true,
  });
  routed.send(JSON.stringify(response));
}

function fixtureResultsForMethod(method) {
  if (method === "runtime.workspaces.list") {
    return {
      success: true,
      items: [{
        workspacePath: FIXTURE.workspacePath,
        label: "Catalog workspace",
        workspaceKind: "workspace",
      }],
      pinnedTaskIds: [],
      taskOrders: {},
    };
  }
  if (method === "runtime.worktrees.list") {
    return {
      success: true,
      items: [{
        deviceId: "catalog-fixture-device",
        worktreeId: FIXTURE.worktreeId,
        path: FIXTURE.worktreePath,
        repositoryName: "Catalog browser worktree",
        sourcePath: FIXTURE.workspacePath,
        permanent: false,
        revision: 1,
        state: "active",
        conversations: [],
      }],
    };
  }
  throw new Error("unsupported synthetic catalog fixture");
}

function discardHeld(socket, record) {
  for (const held of [...socket.heldResponses.values()]) {
    discardOne(socket, held, record, "transport-closed-before-fixture");
  }
}

function discardOne(socket, held, record, disposition) {
  if (!socket.heldResponses.has(held.key)) return;
  socket.heldResponses.delete(held.key);
  if (held.timer) clearTimeout(held.timer);
  record(socket, {
    kind: "held-response-discarded",
    method: safeMethod(held.method),
    requestIdFingerprint: held.requestIdFingerprint,
    disposition,
  });
}

function summarize(sockets) {
  const methodCounts = {};
  const catalogRequestCounts = {};
  let catalogSuppressedCount = 0;
  let catalogInjectedCount = 0;
  let catalogDiscardedOnCloseCount = 0;
  const catalogSocketIds = [];
  let catalogSocketClosedByClient = false;
  let catalogSocketClosedByGateway = false;
  for (const socket of sockets) {
    for (const [method, count] of Object.entries(socket.requestsByMethod)) {
      methodCounts[method] = (methodCounts[method] ?? 0) + count;
    }
    if (Object.keys(socket.catalogRequestsByMethod).length > 0) {
      catalogSocketIds.push(socket.id);
      for (const [method, count] of Object.entries(socket.catalogRequestsByMethod)) {
        catalogRequestCounts[method] = (catalogRequestCounts[method] ?? 0) + count;
      }
      catalogSocketClosedByClient ||= socket.clientClosed;
      catalogSocketClosedByGateway ||= socket.gatewayClosed;
    }
    for (const event of socket.events) {
      if (event.kind === "gateway-response-suppressed") catalogSuppressedCount += 1;
      if (event.kind === "browser-fixture-response-injected") catalogInjectedCount += 1;
      if (event.kind === "held-response-discarded") catalogDiscardedOnCloseCount += 1;
    }
  }
  return {
    methodCounts,
    catalogRequestCounts,
    catalogSocketIds,
    catalogSuppressedCount,
    catalogInjectedCount,
    catalogDiscardedOnCloseCount,
    catalogSocketClosedByClient,
    catalogSocketClosedByGateway,
    catalogInitializeCount: sockets
      .filter(socket => catalogSocketIds.includes(socket.id))
      .reduce((count, socket) => count + socket.initializeCount, 0),
  };
}

function assertColdCatalogCounts(summary) {
  assert.equal(summary.catalogSocketIds.length, 1,
    "a cold Open Project catalog should use one catalog WebSocket connector");
  assert.equal(summary.catalogInitializeCount, 1,
    "the one cold catalog connector should initialize exactly once");
  assert.equal(summary.catalogRequestCounts["runtime.workspaces.list"], 1,
    "cold workspace-directory RPC must be sent once across every socket");
  assert.equal(summary.catalogRequestCounts["runtime.worktrees.list"], 1,
    "cold worktree-directory RPC must be sent once across every socket");
  assert.equal(summary.catalogSuppressedCount, 2,
    "each original Gateway catalog response should be suppressed exactly once");
  assert.equal(summary.catalogInjectedCount, 2,
    "each browser fixture response should be injected exactly once");
  for (const socketId of summary.catalogSocketIds) {
    assert.ok(summary.catalogRequestCounts["runtime.workspaces.list"] <= 1);
    assert.ok(summary.catalogRequestCounts["runtime.worktrees.list"] <= 1);
  }
}

async function readCurrentPins(frozenProductPins, phaseName) {
  assert.ok(frozenProductPins && typeof frozenProductPins === "object",
    "current product pins must come from the hash-pinned verification.json");
  const product = {};
  for (const path of FROZEN_PRODUCT_PATHS) {
    const expected = frozenProductPins[path];
    assert.match(expected ?? "", /^[a-f0-9]{64}$/,
      "freeze evidence is missing a full source hash for " + path);
    const actual = await sha256File(resolve(repoRoot, path));
    assert.equal(actual, expected, "frozen Mobile source pin changed: " + path);
    product[path] = actual;
  }
  const supportPaths = phaseName === "export" ? EXPORT_SUPPORT_PATHS : BROWSER_SUPPORT_PATHS;
  assert.ok(phaseName === "export" || phaseName === "browser", "unknown candidate pin phase");
  const support = await readSupportPins(supportPaths);
  return { product, support, testSourceSha256: await sha256File(scriptPath) };
}

async function readSupportPins(paths) {
  const support = {};
  for (const path of paths) {
    support[path] = await sha256File(resolve(repoRoot, path));
  }
  return support;
}

async function readFreezeEvidence() {
  const path = resolve(repoRoot, "target/private-phone-workspace-catalog-20261009/verification.json");
  const bytes = await readFile(path);
  const evidenceSha256 = sha256(bytes);
  assert.equal(evidenceSha256, EXPECTED_FREEZE_EVIDENCE_SHA256,
    "the frozen verification evidence file changed");
  const evidence = JSON.parse(bytes.toString("utf8"));
  assert.equal(evidence.head, EXPECTED_HEAD, "source freeze evidence HEAD changed");
  const productPins = {};
  for (const pathName of FROZEN_PRODUCT_PATHS) {
    const expected = evidence.files[pathName]?.sha256;
    assert.match(expected ?? "", /^[a-f0-9]{64}$/,
      "freeze evidence does not contain a full source hash for " + pathName);
    productPins[pathName] = expected;
  }
  const reviewPath = "apps/kcoder-studio/mobile/src/runtime/task-runtime.catalog-snapshot-v1.review.test.ts";
  assert.match(evidence.sourceBeforeStatus?.[reviewPath] ?? "", /absent at HEAD/);
  assert.equal(evidence.validation.find(row => row.exitCode === 0 && row.filesPassed === 5)?.testsPassed, 38);
  assert.ok(evidence.validation.some(row => row.command === "node_modules/.bin/tsc --noEmit -p tsconfig.json" && row.exitCode === 0));
  return {
    path,
    sha256: evidenceSha256,
    head: evidence.head,
    productPins,
    validation: evidence.validation.map(row => ({
      command: row.command,
      exitCode: row.exitCode,
      testsPassed: row.testsPassed ?? null,
      filesPassed: row.filesPassed ?? null,
    })),
    reviewTestStatusAtHead: evidence.sourceBeforeStatus[reviewPath],
  };
}

async function readDependencyMetadata(dependencyRoot) {
  const root = await realpath(resolve(dependencyRoot));
  const expoPackagePath = resolve(root, "expo/package.json");
  const expoBytes = await readFile(expoPackagePath);
  const expoPackage = JSON.parse(expoBytes.toString("utf8"));
  assert.equal(typeof expoPackage.version, "string");
  return {
    root,
    expoVersion: expoPackage.version,
    expoPackageJsonSha256: sha256(expoBytes),
  };
}

async function playwrightPackagePin() {
  const packagePath = resolve(appRoot, "renderer/node_modules/@playwright/test/package.json");
  const bytes = await readFile(packagePath);
  const manifest = JSON.parse(bytes.toString("utf8"));
  return {
    name: manifest.name,
    version: manifest.version,
    packagePath,
    packageJsonSha256: sha256(bytes),
  };
}

async function binaryPin(path, version) {
  const canonical = await realpath(path);
  return {
    path: resolve(path),
    realPath: canonical,
    version,
    sha256: await sha256File(canonical),
  };
}

async function collectBundleRows(root) {
  const rootReal = await realpath(root);
  const rows = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = resolve(directory, child.name);
      const info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), "Mobile bundle must not contain symlinks");
      if (info.isDirectory()) {
        await visit(path);
      } else {
        assert.ok(info.isFile(), "Mobile bundle must only contain regular files");
        rows.push({
          path: relative(rootReal, path).split(sep).join("/"),
          size: info.size,
          sha256: await sha256File(path),
        });
      }
    }
  }
  await visit(rootReal);
  rows.sort((left, right) => left.path.localeCompare(right.path));
  return rows;
}

function parseOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    assert.match(key, /^--[a-z][a-z0-9-]*$/);
    assert.ok(index + 1 < args.length, "missing value for " + key);
    assert.ok(!Object.hasOwn(result, key.slice(2)), "duplicate option " + key);
    result[key.slice(2)] = args[++index];
  }
  return result;
}

function requiredOption(values, key) {
  const value = values[key];
  assert.ok(typeof value === "string" && value.length > 0, "required option --" + key);
  return value;
}

function requireSha(value, label) {
  assert.match(value, /^[a-f0-9]{64}$/i, label + " must be a full 64-character SHA-256");
  return value.toLowerCase();
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function parseFrame(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function rpcIdKey(value) {
  return typeof value + ":" + String(value);
}

function fingerprint(value) {
  return sha256(Buffer.from(rpcIdKey(value))).slice(0, 16);
}

function safeSocketPath(routed) {
  try {
    return new URL(typeof routed.url === "function" ? routed.url() : routed.url).pathname;
  } catch {
    return "[unknown]";
  }
}

function safeSocketChannel(routed) {
  try {
    const url = new URL(typeof routed.url === "function" ? routed.url() : routed.url);
    const channel = url.searchParams.get("channel");
    return channel === "runtime" || channel === "browser" ? channel : "other";
  } catch {
    return "unknown";
  }
}

function safeMethod(method) {
  return typeof method === "string" && /^[A-Za-z0-9./_-]{1,120}$/.test(method)
    ? method
    : "[other-method]";
}
