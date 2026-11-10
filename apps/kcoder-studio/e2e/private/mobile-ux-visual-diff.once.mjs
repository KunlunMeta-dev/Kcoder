import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { startApprovalModelFixture } from "../harness/approval-model.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import { captureMobileExportSourceSnapshot } from "../harness/mobile-export-source-snapshot.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { createMobileLatencyHelpers } from "../harness/mobile-latency-helpers.mjs";
import { appRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const BASELINE_BUNDLE_SHA256 = "493ea59638700278ea8e04b3d7eb58fd54299322652adcaac99c365122459025";
const BASELINE_SOURCE_TREE_SHA256 = "f29debc06a5942afe6184e19e900ae168cbe908813e4c347c099d4a9244ffd13";
const BASELINE_DEPENDENCY_TREE_SHA256 = "099337432edafc7345c2f011769b99be243c14896ff772b7c6b7b7b28207ff7c";
const PINNED_KCODER_SHA256 = "7a87160fcf92c32654cfccdb501229c2ee02f6d251c5095be8ba8541e5137d76";
process.umask(0o077);

const mode = process.argv.includes("--capture-source-only")
  ? "capture-source-only"
  : process.argv.includes("--build-baseline") ? "build-baseline"
    : process.argv.includes("--capture-before-ui") ? "capture-before-ui"
      : process.argv.includes("--capture-pair") ? "capture-pair" : "acceptance";

await runE2E(
  import.meta.url,
  {
    testId: "mobile-ux-visual-diff",
    tier: "one-off-acceptance",
    modelPolicy: "one-off Mobile UX visual evidence through an isolated deterministic app-server; no live Provider request or personal session",
    retainSuccessLogs: true,
  },
  async (context) => {
    if (mode === "capture-source-only") {
      const mobileRoot = resolve(appRoot, "mobile");
      const sharedRoot = resolve(appRoot, "shared");
      const snapshotRoot = context.pathInArtifacts("baseline-source-snapshot");
      const snapshot = await captureMobileExportSourceSnapshot({
        sourceRoots: [
          { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
          { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
        ],
        snapshotRoot,
        layout: "preflight-source-root",
        freezeFiles: true,
      });
      const manifest = {
        schemaVersion: 1,
        testId: "mobile-ux-visual-diff",
        mode,
        baselineHead: "2ef15480f64d03b85500f235b343bcce933da8b3",
        snapshotRoot,
        sourceTreeSha256: snapshot.sourceTreeSha256,
        fileCount: snapshot.fileCount,
        byteCount: snapshot.byteCount,
        roots: snapshot.roots,
        evidenceClass: "read-only physical Mobile and shared source copy captured before S1-S3 implementation",
      };
      assert.match(manifest.sourceTreeSha256, /^[a-f0-9]{64}$/);
      assert.ok(manifest.fileCount > 0);
      await context.writeArtifactJson("baseline-source-snapshot.json", manifest);
      await context.writeArtifactJson("baseline-source-inventory.json", snapshot);
      return manifest;
    }

    if (mode === "build-baseline") {
      const snapshotRoot = process.env.KCODER_E2E_MOBILE_UX_BASELINE_SOURCE_ROOT;
      assert.ok(snapshotRoot && isAbsolute(snapshotRoot), "set KCODER_E2E_MOBILE_UX_BASELINE_SOURCE_ROOT to the frozen baseline source root");
      const mobileRoot = resolve(snapshotRoot, "apps/kcoder-studio/mobile");
      const sharedRoot = resolve(snapshotRoot, "apps/kcoder-studio/shared");
      const dependencyRoot = process.env.KCODER_E2E_MOBILE_UX_DEPENDENCY_ROOT || resolve(appRoot, "mobile/node_modules");
      assert.ok(isAbsolute(dependencyRoot), "Mobile dependency root must be absolute");
      const exported = await exportMobileWeb(context, {
        mobileRoot,
        sourceRoots: [
          { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
          { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
        ],
        dependencyRoot,
        label: "mobile-ux-before-export",
        outputName: "mobile-ux-before-web",
        timeoutMs: 10 * 60_000,
        overallTimeoutMs: 45 * 60_000,
      });
      const retainedBundle = context.pathInArtifacts("mobile-web-before");
      await copyRegularTree(exported.path, retainedBundle);
      const result = {
        mode,
        baselineHead: "2ef15480f64d03b85500f235b343bcce933da8b3",
        sourceRoot: snapshotRoot,
        sourceTreeSha256: exported.sourceTreeSha256,
        dependencyRoot: exported.dependencyRoot,
        dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
        buildInputTreeSha256: exported.buildInputTreeSha256,
        bundleRoot: retainedBundle,
        bundleSha256: exported.bundleSha256,
        bundleFileCount: exported.bundleFileCount,
        indexHtmlSha256: exported.indexHtmlSha256,
        sourceSnapshotCopyAndBuildInputMatched: true,
        frozenDependencyInputWasCopiedByRunContextExporter: true,
      };
      await context.writeArtifactJson("mobile-web-before-provenance.json", result);
      return result;
    }

    if (mode === "capture-before-ui") {
      const bundleRoot = process.env.KCODER_E2E_MOBILE_UX_BEFORE_BUNDLE_ROOT;
      assert.ok(bundleRoot && isAbsolute(bundleRoot), "set KCODER_E2E_MOBILE_UX_BEFORE_BUNDLE_ROOT to the retained baseline bundle");
      const suppliedDigest = await hashRegularTree(bundleRoot);
      assert.equal(suppliedDigest, BASELINE_BUNDLE_SHA256, "baseline bundle no longer matches the frozen source export");
      const ownedBundleRoot = context.pathInState("mobile-ux-before-web");
      await copyRegularTree(bundleRoot, ownedBundleRoot);
      assert.equal(await hashRegularTree(ownedBundleRoot), BASELINE_BUNDLE_SHA256, "RunContext baseline bundle copy changed bytes");
      const workspace = await createGeneratedWorkspace(context);
      const model = await startApprovalModelFixture(context, {
        textOnly: true,
        textOnlyResponse: "MOBILE_UX_DETERMINISTIC_REPLY",
      });
      const chromium = await startChromium(context, { label: "mobile-ux-before-chromium" });
      const gatewayResult = await runMobileBrowserScenario(context, {
        label: "before",
        webRoot: ownedBundleRoot,
        expectedUi: "full-form",
        goalTreatment: "slash",
        workspace,
        initializeWorkspace: false,
        model,
        browser: chromium.browser,
        screenshots: {
          newTask: "mobile-ux-before-new-task.png",
          goal: "mobile-ux-before-goal-slash.png",
        },
      });
      await context.writeArtifactJson("mobile-ux-before-ui-provenance.json", {
        schemaVersion: 1,
        mode,
        evidenceClass: "actual isolated Gateway and Chromium against the frozen pre-change Mobile Web bundle",
        bundleRoot: ownedBundleRoot,
        bundleSha256: suppliedDigest,
        viewport: { width: 390, height: 844, deviceScaleFactor: 1, locale: "zh-CN", theme: "light" },
        browserScreenshotIsAndroidDeviceEvidence: false,
        gatewayResult,
      });
      return gatewayResult;
    }

    if (mode === "capture-pair") {
      const beforeBundleRoot = process.env.KCODER_E2E_MOBILE_UX_BEFORE_BUNDLE_ROOT;
      assert.ok(beforeBundleRoot && isAbsolute(beforeBundleRoot), "set KCODER_E2E_MOBILE_UX_BEFORE_BUNDLE_ROOT to the retained baseline bundle");
      const beforeBundleSha256 = await hashRegularTree(beforeBundleRoot);
      assert.equal(beforeBundleSha256, BASELINE_BUNDLE_SHA256, "before bundle no longer matches the frozen source export");

      const mobileRoot = resolve(appRoot, "mobile");
      const sharedRoot = resolve(appRoot, "shared");
      const beforeSourceRoot = process.env.KCODER_E2E_MOBILE_UX_BASELINE_SOURCE_ROOT;
      assert.ok(beforeSourceRoot && isAbsolute(beforeSourceRoot), "set KCODER_E2E_MOBILE_UX_BASELINE_SOURCE_ROOT to the frozen baseline source snapshot");
      const beforeSourceMobileRoot = resolve(beforeSourceRoot, "apps/kcoder-studio/mobile");
      const beforeSourceSharedRoot = resolve(beforeSourceRoot, "apps/kcoder-studio/shared");
      const afterSnapshotRoot = context.pathInArtifacts("after-source-snapshot");
      const afterSnapshot = await captureMobileExportSourceSnapshot({
        sourceRoots: [
          { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
          { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
        ],
        snapshotRoot: afterSnapshotRoot,
        layout: "preflight-source-root",
        freezeFiles: true,
      });
      assert.notEqual(afterSnapshot.sourceTreeSha256, BASELINE_SOURCE_TREE_SHA256, "after Mobile source is identical to the frozen baseline; wait for implementation freeze before capturing");
      const dependencySnapshot = await createMobileLatencyHelpers({}).createDependencySnapshot(context, mobileRoot);
      const dependencyRoot = dependencySnapshot.path;
      assert.ok(isAbsolute(dependencyRoot), "isolated Mobile dependency snapshot must be absolute");
      let baselineExport;
      const pairedBeforeManifestPath = process.env.KCODER_E2E_MOBILE_UX_PAIRED_BEFORE_MANIFEST;
      if (pairedBeforeManifestPath) {
        assert.ok(isAbsolute(pairedBeforeManifestPath), "paired before export manifest must be an absolute path");
        const priorBaselineManifest = JSON.parse(await readFile(pairedBeforeManifestPath, "utf8"));
        assert.equal(priorBaselineManifest.status, "complete", "reused paired before export must have completed successfully");
        assert.equal(priorBaselineManifest.sourceTreeSha256, BASELINE_SOURCE_TREE_SHA256, "reused paired before export must use the pinned baseline source");
        assert.equal(priorBaselineManifest.bundleSha256, beforeBundleSha256, "reused paired before bundle must match the frozen baseline bundle");
        const priorDependencySha256 = priorBaselineManifest.dependencyProvenance?.sourceTreeSha256Before;
        assert.match(priorDependencySha256 ?? "", /^[a-f0-9]{64}$/, "reused paired before export must record its dependency snapshot hash");
        assert.equal(priorBaselineManifest.dependencyProvenance?.sourceTreeSha256After, priorDependencySha256, "reused paired before dependency snapshot changed during export");
        const priorRunRoot = dirname(dirname(pairedBeforeManifestPath));
        const priorBundleRoot = resolve(dirname(pairedBeforeManifestPath), "mobile-web-before-pair");
        assert.ok(priorBundleRoot.startsWith(`${priorRunRoot}/`), "reused paired before bundle path must remain inside its RunContext");
        assert.equal(await hashRegularTree(priorBundleRoot), priorBaselineManifest.bundleSha256, "reused paired before bundle bytes differ from its export manifest");
        baselineExport = {
          path: priorBundleRoot,
          sourceTreeSha256: priorBaselineManifest.sourceTreeSha256,
          dependencySourceTreeSha256: priorDependencySha256,
          bundleSha256: priorBaselineManifest.bundleSha256,
          provenanceManifestPath: pairedBeforeManifestPath,
        };
      } else {
        baselineExport = await exportMobileWeb(context, {
          mobileRoot: beforeSourceMobileRoot,
          sourceRoots: [
            { name: "mobile", path: beforeSourceMobileRoot, destination: "apps/kcoder-studio/mobile" },
            { name: "studio-shared", path: beforeSourceSharedRoot, destination: "apps/kcoder-studio/shared" },
          ],
          dependencyRoot,
          label: "mobile-ux-pair-before-export",
          outputName: "mobile-ux-pair-before-web",
          stateNamespace: "mobile-ux-pair-before-state",
          timeoutMs: 10 * 60_000,
          overallTimeoutMs: 45 * 60_000,
        });
      }
      assert.equal(baselineExport.sourceTreeSha256, BASELINE_SOURCE_TREE_SHA256, "paired before export must use the pinned pre-change source snapshot");
      const ownedBeforeRoot = context.pathInArtifacts("mobile-web-before-pair");
      await copyRegularTree(baselineExport.path, ownedBeforeRoot);
      assert.equal(await hashRegularTree(ownedBeforeRoot), baselineExport.bundleSha256, "RunContext paired before bundle copy changed bytes");

      const afterSourceMobileRoot = resolve(afterSnapshotRoot, "apps/kcoder-studio/mobile");
      let afterExport;
      let afterSourceCompatibility;
      const pairedAfterManifestPath = process.env.KCODER_E2E_MOBILE_UX_PAIRED_AFTER_MANIFEST;
      if (pairedAfterManifestPath) {
        assert.ok(isAbsolute(pairedAfterManifestPath), "paired after export manifest must be an absolute path");
        const priorAfterManifest = JSON.parse(await readFile(pairedAfterManifestPath, "utf8"));
        assert.equal(priorAfterManifest.status, "complete", "reused paired after export must have completed successfully");
        const priorRunRoot = dirname(dirname(pairedAfterManifestPath));
        const priorSourceSnapshotRoot = resolve(priorRunRoot, "artifacts/after-source-snapshot");
        const sourceDifferences = await diffRegularTrees(priorSourceSnapshotRoot, afterSnapshotRoot);
        if (priorAfterManifest.sourceTreeSha256 === afterSnapshot.sourceTreeSha256) {
          assert.deepEqual(sourceDifferences, [], "matching source hashes must have matching captured source files");
          afterSourceCompatibility = { kind: "exact-source-match", bundleSourceTreeSha256: priorAfterManifest.sourceTreeSha256, currentSourceTreeSha256: afterSnapshot.sourceTreeSha256, differences: [] };
        } else {
          const testOnlyDifferences = [
            "apps/kcoder-studio/mobile/src/app/__tests__/forms-scope.review.test.tsx",
          ];
          assert.deepEqual(sourceDifferences, testOnlyDifferences, "reused after bundle may differ from current captured source only by the explicitly pinned test-only files");
          afterSourceCompatibility = {
            kind: "runtime-source-match-with-pinned-test-only-differences",
            bundleSourceTreeSha256: priorAfterManifest.sourceTreeSha256,
            currentSourceTreeSha256: afterSnapshot.sourceTreeSha256,
            differences: sourceDifferences,
          };
        }
        const priorDependencySha256 = priorAfterManifest.dependencyProvenance?.sourceTreeSha256Before;
        assert.equal(priorDependencySha256, baselineExport.dependencySourceTreeSha256, "reused paired after export must use the exact before dependency snapshot");
        assert.equal(priorAfterManifest.dependencyProvenance?.sourceTreeSha256After, priorDependencySha256, "reused paired after dependency snapshot changed during export");
        const priorBundleRoot = resolve(dirname(pairedAfterManifestPath), "mobile-web-after");
        assert.ok(priorBundleRoot.startsWith(`${priorRunRoot}/`), "reused paired after bundle path must remain inside its RunContext");
        assert.equal(await hashRegularTree(priorBundleRoot), priorAfterManifest.bundleSha256, "reused paired after bundle bytes differ from its export manifest");
        afterExport = {
          path: priorBundleRoot,
          sourceTreeSha256: priorAfterManifest.sourceTreeSha256,
          dependencySourceTreeSha256: priorDependencySha256,
          bundleSha256: priorAfterManifest.bundleSha256,
          bundleFileCount: priorAfterManifest.bundleFileCount,
          indexHtmlSha256: priorAfterManifest.indexHtmlSha256,
          buildInputTreeSha256: priorAfterManifest.buildInputTreeSha256,
          dependencyOwnedTreeSha256: priorAfterManifest.dependencyProvenance?.copiedTreeSha256,
          provenanceManifestPath: pairedAfterManifestPath,
        };
      } else {
        afterExport = await exportMobileWeb(context, {
          mobileRoot: afterSourceMobileRoot,
          sourceRoots: [
            { name: "mobile", path: afterSourceMobileRoot, destination: "apps/kcoder-studio/mobile" },
            { name: "studio-shared", path: resolve(afterSnapshotRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
          ],
          dependencyRoot,
          label: "mobile-ux-after-export",
          outputName: "mobile-ux-after-web",
          stateNamespace: "mobile-ux-pair-after-state",
          timeoutMs: 10 * 60_000,
          overallTimeoutMs: 45 * 60_000,
        });
        afterSourceCompatibility = { kind: "exact-source-match", bundleSourceTreeSha256: afterExport.sourceTreeSha256, currentSourceTreeSha256: afterSnapshot.sourceTreeSha256, differences: [] };
      }
      assert.equal(afterExport.sourceTreeSha256, afterSourceCompatibility.bundleSourceTreeSha256, "after bundle source differs from its retained export provenance");
      assert.equal(afterSnapshot.sourceTreeSha256, afterSourceCompatibility.currentSourceTreeSha256, "current after source snapshot differs from its compatibility evidence");
      assert.equal(afterExport.dependencySourceTreeSha256, baselineExport.dependencySourceTreeSha256, "paired before/after exports must use one exact dependency snapshot");
      const retainedAfterRoot = context.pathInArtifacts("mobile-web-after");
      await copyRegularTree(afterExport.path, retainedAfterRoot);
      assert.equal(await hashRegularTree(retainedAfterRoot), afterExport.bundleSha256, "RunContext after bundle copy changed bytes");
      await context.writeArtifactJson("mobile-web-after-provenance.json", {
        schemaVersion: 1,
        mode,
        originalBaselineBundleRoot: beforeBundleRoot,
        originalBaselineBundleSha256: beforeBundleSha256,
        pairedBeforeBundleRoot: ownedBeforeRoot,
        pairedBeforeBundleSha256: baselineExport.bundleSha256,
        pairedBeforeSourceTreeSha256: baselineExport.sourceTreeSha256,
        pairedBeforeDependencyTreeSha256: baselineExport.dependencySourceTreeSha256,
        pairedBeforeExportManifestPath: baselineExport.provenanceManifestPath ?? null,
        pairedAfterExportManifestPath: afterExport.provenanceManifestPath ?? null,
        isolatedDependencySnapshot: dependencySnapshot,
        sourceSnapshotRoot: afterSnapshotRoot,
        bundleSourceTreeSha256: afterExport.sourceTreeSha256,
        currentSourceTreeSha256: afterSnapshot.sourceTreeSha256,
        currentSourceCompatibility: afterSourceCompatibility,
        exporterBuildInputTreeSha256: afterExport.buildInputTreeSha256,
        dependencySourceTreeSha256: afterExport.dependencySourceTreeSha256,
        dependencyOwnedTreeSha256: afterExport.dependencyOwnedTreeSha256,
        bundleRoot: retainedAfterRoot,
        bundleSha256: afterExport.bundleSha256,
        bundleFileCount: afterExport.bundleFileCount,
        indexHtmlSha256: afterExport.indexHtmlSha256,
        originalBaselineSourceTreeSha256: BASELINE_SOURCE_TREE_SHA256,
        originalBaselineDependencyTreeSha256: BASELINE_DEPENDENCY_TREE_SHA256,
      });

      const workspace = await createGeneratedWorkspace(context);
      const model = await startApprovalModelFixture(context, {
        textOnly: true,
        textOnlyResponse: "MOBILE_UX_DETERMINISTIC_REPLY",
      });
      const chromium = await startChromium(context, { label: "mobile-ux-pair-chromium" });
      const before = await runMobileBrowserScenario(context, {
        label: "before",
        webRoot: ownedBeforeRoot,
        expectedUi: "full-form",
        goalTreatment: "slash",
        workspace,
        initializeWorkspace: false,
        model,
        browser: chromium.browser,
        screenshots: {
          newTask: "mobile-ux-before-new-task.png",
          goal: "mobile-ux-before-goal-slash.png",
        },
      });
      const after = await runMobileBrowserScenario(context, {
        label: "after",
        webRoot: retainedAfterRoot,
        expectedUi: "draft",
        goalTreatment: "persistent",
        workspace,
        initializeWorkspace: false,
        model,
        browser: chromium.browser,
        screenshots: {
          newTask: "mobile-ux-after-new-draft.png",
          goal: "mobile-ux-after-goal-controls.png",
          keyboardSimulation: "mobile-ux-after-web-viewport-keyboard-simulation.png",
          dark320: "mobile-ux-after-dark-320-sanity.png",
        },
      });
      const pair = {
        schemaVersion: 1,
        mode,
        workspace,
        sameGeneratedWorkspace: before.workspace === after.workspace,
        sourceBaselineBundleSha256: beforeBundleSha256,
        beforeBundleSha256: baselineExport.bundleSha256,
        afterBundleSha256: afterExport.bundleSha256,
        beforeSourceTreeSha256: BASELINE_SOURCE_TREE_SHA256,
        afterSourceTreeSha256: afterExport.sourceTreeSha256,
        currentAfterSourceTreeSha256: afterSnapshot.sourceTreeSha256,
        afterSourceCompatibility,
        beforeDependencyTreeSha256: baselineExport.dependencySourceTreeSha256,
        afterDependencyTreeSha256: afterExport.dependencySourceTreeSha256,
        sameDependencyTreeSha256: afterExport.dependencySourceTreeSha256 === baselineExport.dependencySourceTreeSha256,
        viewport: { width: 390, height: 844, deviceScaleFactor: 1, locale: "zh-CN", theme: "light" },
        before,
        after,
        keyboardEvidenceClass: "Web viewport resize simulation only; no Android IME or native phone was exercised",
        screenshots: [
          "mobile-ux-before-new-task.png",
          "mobile-ux-after-new-draft.png",
          "mobile-ux-before-goal-slash.png",
          "mobile-ux-after-goal-controls.png",
          "mobile-ux-after-web-viewport-keyboard-simulation.png",
          "mobile-ux-after-dark-320-sanity.png",
        ],
      };
      assert.equal(pair.sameGeneratedWorkspace, true);
      assert.equal(pair.sameDependencyTreeSha256, true);
      await context.writeArtifactJson("mobile-ux-visual-diff-pair.json", pair);
      return pair;
    }

    assert.fail("pass --capture-source-only, --build-baseline, --capture-before-ui, or --capture-pair");
  },
);

async function copyRegularTree(sourceRoot, destinationRoot) {
  await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const source = resolve(sourceRoot, entry.name);
    const destination = resolve(destinationRoot, entry.name);
    const info = await lstat(source);
    assert.ok(!info.isSymbolicLink(), `Mobile Web output cannot contain symlinks: ${relative(sourceRoot, source)}`);
    if (info.isDirectory()) await copyRegularTree(source, destination);
    else {
      assert.ok(info.isFile(), `Mobile Web output must contain regular files: ${relative(sourceRoot, source)}`);
      await copyFile(source, destination);
    }
  }
}

async function hashRegularTree(root) {
  const rows = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = resolve(directory, child.name);
      const info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), `bundle cannot contain symlinks: ${relative(root, path)}`);
      if (info.isDirectory()) await visit(path);
      else {
        assert.ok(info.isFile(), `bundle must contain regular files: ${relative(root, path)}`);
        const bytes = await readFile(path);
        rows.push({
          path: relative(root, path).split("\\").join("/"),
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await visit(root);
  rows.sort((left, right) => left.path.localeCompare(right.path));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function diffRegularTrees(leftRoot, rightRoot) {
  async function inventory(root) {
    const rows = new Map();
    async function visit(directory) {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        const path = resolve(directory, child.name);
        const info = await lstat(path);
        assert.ok(!info.isSymbolicLink(), `source snapshot cannot contain symlinks: ${relative(root, path)}`);
        if (info.isDirectory()) await visit(path);
        else {
          assert.ok(info.isFile(), `source snapshot must contain regular files: ${relative(root, path)}`);
          const bytes = await readFile(path);
          rows.set(relative(root, path).split("\\").join("/"), {
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
        }
      }
    }
    await visit(root);
    return rows;
  }

  const left = await inventory(leftRoot);
  const right = await inventory(rightRoot);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a.localeCompare(b));
  return paths.filter(path => JSON.stringify(left.get(path) ?? null) !== JSON.stringify(right.get(path) ?? null));
}

async function createGeneratedWorkspace(context) {
  const workspace = context.pathInState("mobile-ux-generated-workspace");
  await mkdir(workspace, { recursive: false, mode: 0o700 });
  await writeFile(
    resolve(workspace, "README.md"),
    "# Mobile UX visual acceptance fixture\n\nGenerated for this isolated browser run.\n",
    { flag: "wx", mode: 0o600 },
  );
  return workspace;
}

async function runMobileBrowserScenario(context, {
  label,
  webRoot,
  expectedUi,
  goalTreatment,
  screenshots,
  workspace,
  initializeWorkspace,
  model,
  browser,
}) {
  assert.ok(workspace && isAbsolute(workspace), "scenario must receive its RunContext-owned generated workspace");
  assert.ok(browser && model, "scenario requires the startChromium-owned browser and deterministic local model fixture");
  if (initializeWorkspace) assert.equal(await createGeneratedWorkspace(context), workspace);
  else assert.ok((await lstat(workspace)).isDirectory(), "generated workspace must remain owned and available");
  const modelRequestsBefore = model.requests.length;

  const configDir = context.pathInState(`mobile-ux-${label}-config`);
  await mkdir(configDir, { recursive: false, mode: 0o700 });
  const settingsFile = await context.writeStateJson(`mobile-ux-${label}-settings.json`, {
    active_provider: "mobile-ux-fixture",
    permission_mode: "yolo",
    providers: { "mobile-ux-fixture": provider(model.baseUrl) },
  });
  await context.writeStateJson(`mobile-ux-${label}-config/settings.json`, {});
  await context.writeStateJson(`mobile-ux-${label}-config/credentials.json`, {
    "mobile-ux-fixture": { type: "api", key: "deterministic-local" },
  });

  const cliSource = resolve(
    process.env.KCODER_E2E_KCODER_BIN || "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/debug/kcoder",
  );
  assert.ok(isAbsolute(cliSource), "KCoder CLI input path must be absolute");
  const cliInfo = await lstat(cliSource);
  assert.ok(cliInfo.isFile() && !cliInfo.isSymbolicLink(), "KCoder CLI input must be a regular binary, not a symlink");
  const cliDigest = await hashFile(cliSource);
  assert.equal(cliDigest, PINNED_KCODER_SHA256, "KCoder CLI binary changed from the pinned acceptance build");
  const ownedCli = context.pathInState(`kcoder-mobile-ux-pinned-${label}`);
  await copyFile(cliSource, ownedCli);
  await chmod(ownedCli, 0o500);
  assert.equal(await hashFile(ownedCli), PINNED_KCODER_SHA256, "RunContext-owned KCoder CLI copy changed bytes");

  const serversFile = await context.writeStateJson(`mobile-ux-${label}-servers.json`, [{
    id: "local",
    label: "本机",
    transport: "local",
    command: ownedCli,
    workspace,
    settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true,
    label: `mobile-ux-${label}-gateway`,
    workspace,
    serversFile,
    kcoderBin: ownedCli,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: webRoot },
  });
  const browserContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await browserContext.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("kcoder-studio:mobile-app-preferences:v1", JSON.stringify({
      language: "zh-CN",
      theme: "light",
      terminalScrollbackLines: 10_000,
      conversationFontScale: "normal",
      conversationLineSpacing: "normal",
      conversationBlockSpacing: "normal",
      conversationLetterSpacing: "normal",
      conversationFontFamily: "noto-sans-sc",
      thinkingCollapsedByDefault: true,
      toolsCollapsedByDefault: true,
      quickPhrases: [],
    }));
  });
  const diagnostics = [];
  const rpcMethods = [];
  const rpcResponses = [];
  const rpcMethodById = new Map();
  let rpcSocketSequence = 0;
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
  });
  page.on("websocket", socket => {
    const socketId = ++rpcSocketSequence;
    socket.on("framesent", event => {
      try {
        const value = JSON.parse(String(event.payload));
        for (const frame of Array.isArray(value) ? value : [value]) {
          if (!frame?.method) continue;
          rpcMethods.push({ socketId, id: frame.id ?? null, method: frame.method, params: frame.params ?? null });
          if (frame.id !== undefined) rpcMethodById.set(`${socketId}:${String(frame.id)}`, frame.method);
        }
      } catch { /* Non-JSON frames are outside the JSON-RPC evidence. */ }
    });
    socket.on("framereceived", event => {
      try {
        const value = JSON.parse(String(event.payload));
        for (const frame of Array.isArray(value) ? value : [value]) {
          if (frame?.id === undefined) continue;
          const requestKey = `${socketId}:${String(frame.id)}`;
          const method = rpcMethodById.get(requestKey);
          if (method?.startsWith("thread/goal/")) {
            rpcResponses.push({
              socketId,
              id: frame.id,
              method,
              result: frame.result ?? null,
              error: frame.error ? { code: frame.error.code ?? null } : null,
            });
          }
          rpcMethodById.delete(requestKey);
        }
      } catch { /* Non-JSON frames are outside the JSON-RPC evidence. */ }
    });
  });

  await connect(page, gateway);
  const projectAction = page.getByText("在此项目新建任务", { exact: true });
  await projectAction.waitFor({ state: "visible", timeout: 30_000 });
  assert.ok(await page.getByText(workspace, { exact: true }).count() >= 1, "home must expose the generated configured workspace");
  await projectAction.click();
  await page.getByTestId(expectedUi === "full-form" ? "new-workspace-prompt" : "new-task-draft").waitFor({
    state: "visible",
    timeout: 30_000,
  });

  if (expectedUi === "full-form") {
    assert.equal(await page.getByTestId("new-task-draft").count(), 0, "baseline known-workspace action should still open the full New form");
    assert.equal(await page.getByTestId("new-workspace-prompt").count(), 1);
  } else {
    assert.equal(await page.getByTestId("new-workspace-prompt").count(), 0, "known-workspace action should open a blank task draft");
  }

  await page.screenshot({ path: context.pathInArtifacts(screenshots.newTask), animations: "disabled" });
  if (expectedUi === "full-form") {
    await page.getByTestId("new-workspace-prompt").fill("MOBILE_UX_OLD_BOOTSTRAP");
    await page.getByTestId("create-workspace").click();
  } else {
    await page.getByTestId("message-input").fill("MOBILE_UX_FIRST_SEND");
    await page.getByTestId("send-message").click();
  }
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 60_000 });
  await page.getByTestId("message-user").filter({ hasText: expectedUi === "full-form" ? "MOBILE_UX_OLD_BOOTSTRAP" : "MOBILE_UX_FIRST_SEND" })
    .waitFor({ state: "visible", timeout: 60_000 });
  await page.getByText("MOBILE_UX_DETERMINISTIC_REPLY", { exact: true }).first().waitFor({ state: "visible", timeout: 60_000 });
  await waitFor(() => model.requests.length === modelRequestsBefore + 1, 30_000, `${label} deterministic first-send model request`);
  assert.equal(rpcMethods.filter(row => row.method === "thread/start").length, 1, `${label} must create exactly one thread on first send`);
  assert.equal(rpcMethods.filter(row => row.method === "turn/start").length, 1, `${label} first send must produce one provider turn`);
  const threadStart = rpcMethods.find(row => row.method === "thread/start");
  assert.ok(JSON.stringify(threadStart?.params).includes(workspace), "thread/start must target the generated known workspace");

  const composer = page.getByTestId("message-input");
  let keyboardSimulation = null;
  let dark320 = null;
  let goalLifecycle = null;
  if (goalTreatment === "slash") {
    await composer.fill("/");
    await page.getByTestId("slash-command-menu").waitFor({ state: "visible", timeout: 10_000 });
    assert.ok((await page.getByTestId("slash-command-menu").innerText()).includes("/goal"), "the baseline slash menu must expose Goal in this browser flow");
    await page.screenshot({ path: context.pathInArtifacts(screenshots.goal), animations: "disabled" });
  } else {
    assert.equal(goalTreatment, "persistent");
    const objective = "MOBILE_UX_GOAL_PERSISTENCE";
    await composer.fill(`/goal ${objective}`);
    await page.getByTestId("send-message").click();
    await waitFor(() => rpcMethods.some(row => row.method === "thread/goal/set" && row.params?.objective === objective), 30_000, "Goal set RPC through Gateway");
    await page.getByText("/goal 已启动", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("task-goal-controls").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("task-goal-objective").filter({ hasText: objective }).waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(() => model.requests.length === modelRequestsBefore + 2, 30_000, "Goal command deterministic provider request");

    await page.getByTestId("task-goal-pause").click();
    await page.getByTestId("task-goal-resume").waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await page.getByTestId("task-goal-status").innerText(), /已暂停/);
    await page.getByTestId("task-goal-resume").click();
    await page.getByTestId("task-goal-pause").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(rpcMethods.filter(row => row.method === "turn/start").length, 2, "Goal status buttons must not start provider turns");
    assert.equal(model.requests.length - modelRequestsBefore, 2, "Goal status buttons must not make provider requests");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 60_000 });
    await page.getByTestId("task-goal-objective").filter({ hasText: objective }).waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(() => rpcMethods.some(row => row.method === "thread/goal/get"), 30_000, "Goal reload read RPC");
    assert.equal(rpcMethods.filter(row => row.method === "thread/start").length, 1, "Goal reload must not create another thread");
    assert.equal(rpcMethods.filter(row => row.method === "turn/start").length, 2, "Goal controls and reload must not start another turn");
    await page.screenshot({ path: context.pathInArtifacts(screenshots.goal), animations: "disabled" });

    const lifecycleRequests = [];
    const latestGoalRequest = method => [...rpcMethods].reverse().find(row => row.method === method);
    const responseFor = async (request, description) => {
      assert.ok(request?.id !== null && request?.id !== undefined, `${description} request must carry a JSON-RPC id`);
      await waitFor(() => rpcResponses.some(row => row.socketId === request.socketId && String(row.id) === String(request.id)), 30_000, `${description} response`);
      const response = rpcResponses.find(row => row.socketId === request.socketId && String(row.id) === String(request.id));
      assert.equal(response.method, request.method, `${description} response must match its request method`);
      assert.equal(response.error, null, `${description} must return a successful server receipt`);
      assert.ok(response.result, `${description} must include a server result`);
      return response.result;
    };
    const goalSummary = goal => goal == null ? null : ({
      goalId: goal.goalId,
      revision: goal.revision,
      objective: goal.objective,
      status: goal.status,
      mode: goal.mode,
    });

    const currentGoalRequest = latestGoalRequest("thread/goal/get");
    const currentGoalResult = await responseFor(currentGoalRequest, "Goal reload before edit");
    const currentGoal = currentGoalResult.goal;
    assert.ok(currentGoal?.goalId && Number.isInteger(currentGoal.revision), "Goal reload must return its authoritative identity and revision");
    assert.equal(currentGoal.objective, objective, "Goal reload must return the created objective");

    const pauseRequestCount = rpcMethods.filter(row => row.method === "thread/goal/set" && row.params?.status === "paused").length;
    await page.getByTestId("task-goal-pause").click();
    await page.getByTestId("task-goal-resume").waitFor({ state: "visible", timeout: 30_000 });
    const pauseRequest = await waitFor(() => {
      const requests = rpcMethods.filter(row => row.method === "thread/goal/set" && row.params?.status === "paused");
      return requests.length > pauseRequestCount ? requests.at(-1) : null;
    }, 30_000, "Goal pause before edit request");
    const pauseResult = await responseFor(pauseRequest, "Goal pause before edit");
    assert.equal(pauseResult.goal?.status, "paused", "pause action must be acknowledged as paused");
    assert.equal(pauseResult.goal?.goalId, currentGoal.goalId, "pause must retain the Goal identity");
    lifecycleRequests.push({
      method: pauseRequest.method,
      params: { status: pauseRequest.params.status, expectedGoalId: pauseRequest.params.expectedGoalId, expectedRevision: pauseRequest.params.expectedRevision },
      receipt: goalSummary(pauseResult.goal),
    });

    const editedObjective = "MOBILE_UX_GOAL_EDITED";
    await page.getByTestId("task-goal-edit").click();
    const editInput = page.getByTestId("task-goal-edit-input");
    await editInput.waitFor({ state: "visible", timeout: 10_000 });
    await editInput.fill(editedObjective);
    const editRequestCount = rpcMethods.filter(row => row.method === "thread/goal/set" && row.params?.edit === true).length;
    await page.getByTestId("task-goal-save").click();
    const editRequest = await waitFor(() => {
      const requests = rpcMethods.filter(row => row.method === "thread/goal/set" && row.params?.edit === true && row.params?.objective === editedObjective);
      return requests.length > editRequestCount ? requests.at(-1) : null;
    }, 30_000, "Goal edit request with new objective");
    assert.equal(editRequest.params.expectedGoalId, pauseResult.goal.goalId, "Goal edit must use the paused Goal identity for CAS");
    assert.equal(editRequest.params.expectedRevision, pauseResult.goal.revision, "Goal edit must use the paused Goal revision for CAS");
    const editResult = await responseFor(editRequest, "Goal edit");
    assert.equal(editResult.goal?.goalId, currentGoal.goalId, "Goal edit receipt must retain the same Goal identity");
    assert.ok(Number.isInteger(editResult.goal?.revision) && editResult.goal.revision > pauseResult.goal.revision, "Goal edit receipt must advance its revision");
    assert.equal(editResult.goal?.objective, editedObjective, "Goal edit receipt must contain the submitted objective");
    assert.equal(editResult.goal?.status, "paused", "editing a paused Goal must preserve its paused status");
    await editInput.waitFor({ state: "hidden", timeout: 30_000 });
    await page.getByTestId("task-goal-objective").filter({ hasText: editedObjective }).waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await page.getByTestId("task-goal-status").innerText(), /已暂停/);
    lifecycleRequests.push({
      method: editRequest.method,
      params: { edit: editRequest.params.edit, objective: editRequest.params.objective, expectedGoalId: editRequest.params.expectedGoalId, expectedRevision: editRequest.params.expectedRevision },
      receipt: goalSummary(editResult.goal),
    });

    const readsBeforeEditedReload = rpcMethods.filter(row => row.method === "thread/goal/get").length;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 60_000 });
    await page.getByTestId("task-goal-objective").filter({ hasText: editedObjective }).waitFor({ state: "visible", timeout: 30_000 });
    const editedReloadRequest = await waitFor(() => {
      const requests = rpcMethods.filter(row => row.method === "thread/goal/get");
      return requests.length > readsBeforeEditedReload ? requests.at(-1) : null;
    }, 30_000, "edited Goal reload read request");
    const editedReloadResult = await responseFor(editedReloadRequest, "edited Goal reload");
    assert.deepEqual(goalSummary(editedReloadResult.goal), goalSummary(editResult.goal), "reload must restore the server-acknowledged edited paused Goal");
    assert.match(await page.getByTestId("task-goal-status").innerText(), /已暂停/);

    const clearRequestCount = rpcMethods.filter(row => row.method === "thread/goal/clear").length;
    await page.getByTestId("task-goal-clear").click();
    const clearRequest = await waitFor(() => {
      const requests = rpcMethods.filter(row => row.method === "thread/goal/clear");
      return requests.length > clearRequestCount ? requests.at(-1) : null;
    }, 30_000, "Goal clear request");
    assert.equal(clearRequest.params.expectedGoalId, editResult.goal.goalId, "Goal clear must use the edited Goal identity for CAS");
    assert.equal(clearRequest.params.expectedRevision, editResult.goal.revision, "Goal clear must use the edited Goal revision for CAS");
    const clearResult = await responseFor(clearRequest, "Goal clear");
    assert.equal(clearResult.cleared, true, "Goal clear must return a successful cleared receipt");
    lifecycleRequests.push({
      method: clearRequest.method,
      params: { expectedGoalId: clearRequest.params.expectedGoalId, expectedRevision: clearRequest.params.expectedRevision },
      receipt: { cleared: clearResult.cleared },
    });
    await page.getByTestId("task-goal-controls").waitFor({ state: "detached", timeout: 30_000 });

    const readsBeforeClearedReload = rpcMethods.filter(row => row.method === "thread/goal/get").length;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 60_000 });
    const clearedReloadRequest = await waitFor(() => {
      const requests = rpcMethods.filter(row => row.method === "thread/goal/get");
      return requests.length > readsBeforeClearedReload ? requests.at(-1) : null;
    }, 30_000, "cleared Goal reload read request");
    const clearedReloadResult = await responseFor(clearedReloadRequest, "cleared Goal reload");
    assert.equal(clearedReloadResult.goal, null, "reload after clear must read no Goal from the server");
    assert.equal(await page.getByTestId("task-goal-controls").count(), 0, "Goal controls must remain absent after reload");
    goalLifecycle = {
      requests: lifecycleRequests,
      reloadAfterEdit: { method: editedReloadRequest.method, receipt: goalSummary(editedReloadResult.goal) },
      reloadAfterClear: { method: clearedReloadRequest.method, receipt: { goal: clearedReloadResult.goal } },
      editReceiptAndReloadMatch: JSON.stringify(goalSummary(editResult.goal)) === JSON.stringify(goalSummary(editedReloadResult.goal)),
      clearReceiptAndReloadMatch: clearedReloadResult.goal === null,
    };
    assert.equal(rpcMethods.filter(row => row.method === "turn/start").length, 2, "Goal edit, clear, and reload must not start another turn");
    assert.equal(model.requests.length - modelRequestsBefore, 2, "Goal edits, clear, and reload must not make provider requests");

    if (screenshots.keyboardSimulation) {
      await composer.fill("");
      await composer.focus();
      await page.setViewportSize({ width: 390, height: 560 });
      await page.waitForFunction(() => Math.round(window.visualViewport?.height ?? window.innerHeight) <= 560);
      const viewport = await page.evaluate(() => ({
        width: Math.round(window.visualViewport?.width ?? window.innerWidth),
        height: Math.round(window.visualViewport?.height ?? window.innerHeight),
        composerBottom: Math.round(document.querySelector('[data-testid="message-input-root"]')?.getBoundingClientRect().bottom ?? -1),
        focused: document.activeElement?.getAttribute("data-testid") === "message-input",
      }));
      assert.equal(viewport.width, 390);
      assert.ok(viewport.height <= 560 && viewport.height > 0, "Web visual viewport must reflect the simulated resize");
      assert.ok(viewport.composerBottom <= viewport.height + 1, "composer should remain within the resized Web viewport");
      assert.equal(viewport.focused, true, "composer remains focused during Web viewport resize simulation");
      await page.screenshot({ path: context.pathInArtifacts(screenshots.keyboardSimulation), animations: "disabled" });
      keyboardSimulation = { ...viewport, screenshot: screenshots.keyboardSimulation, simulationOnly: true, androidImeExercised: false };
    }
    if (screenshots.dark320) {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.setViewportSize({ width: 320, height: 568 });
      await page.waitForTimeout(100);
      dark320 = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
      }));
      assert.ok(Math.max(dark320.documentWidth, dark320.bodyWidth) <= 321, "dark 320px sanity must not introduce horizontal overflow");
      await page.screenshot({ path: context.pathInArtifacts(screenshots.dark320), animations: "disabled" });
    }

  }

  const currentThreadId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1));
  assert.match(currentThreadId, /^[A-Za-z0-9._:-]+$/);
  assert.deepEqual(diagnostics.filter(message => message.startsWith("pageerror:")), [], "browser page errors must remain empty");
  const screenshotFiles = [screenshots.newTask, screenshots.goal, screenshots.keyboardSimulation, screenshots.dark320].filter(Boolean);
  for (const file of screenshotFiles) {
    const screenshot = await lstat(context.pathInArtifacts(file));
    assert.ok(screenshot.isFile(), `${label} required screenshot was not written: ${file}`);
  }
  await context.writeArtifactJson(`mobile-ux-${label}-browser.json`, {
    label,
    webRoot,
    viewport: { width: 390, height: 844, deviceScaleFactor: 1, locale: "zh-CN", theme: "light" },
    expectedUi,
    workspace,
    threadId: currentThreadId,
    ownedCliSha256: cliDigest,
    screenshotFiles,
    rpcMethods,
    goalLifecycle,
    modelRequestCount: model.requests.length - modelRequestsBefore,
    browserDiagnostics: diagnostics,
    keyboardSimulation,
    dark320,
    evidenceClass: "isolated browser and deterministic local model fixture; screenshots are not Android device evidence",
  });
  await browserContext.close();
  await context.stopOwned(`mobile-ux-${label}-gateway`);
  return {
    label,
    workspace,
    threadId: currentThreadId,
    screenshotFiles,
    rpcMethods: rpcMethods.map(row => row.method),
    goalLifecycle,
    modelRequestCount: model.requests.length - modelRequestsBefore,
    browserDiagnostics: diagnostics,
    ownedCliSha256: cliDigest,
    keyboardSimulation,
    dark320,
  };
}

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

function provider(endpoint) {
  return {
    api_format: "openai_chat_completions",
    endpoint,
    default_model: "mobile-ux-e2e-model",
    context_window_tokens: 128000,
    output_headroom_tokens: 8192,
    max_output_tokens: 8192,
    request_timeout_secs: 30,
    no_proxy: true,
    extra_body: {},
  };
}

async function hashFile(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}
