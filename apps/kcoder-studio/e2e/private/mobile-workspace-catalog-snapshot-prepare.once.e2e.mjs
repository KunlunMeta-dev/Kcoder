// Recover the completed Expo output from the first one-shot RunContext and prepare
// the production Gateway manifest without rebuilding or modifying product source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGatewayMobileWebManifest,
  writeGatewayMobileWebManifest,
} from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { verifyMobileExportManifestEnvelope } from "../harness/mobile-web-export-input.mjs";
import { appRoot, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const EXPECTED_REPO_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/worktree/2026/10/09/mobile-ux-followup-20261009";
const EXPECTED_NODE_PATH = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const EXPECTED_FREEZE_EVIDENCE_SHA256 = "8b0b6fda529890f9a8e16edf45363464a7f710765bc7f4411b76ba2a31e3abf3";
const EXPECTED_CHROMIUM_HELPER_SHA256 = "e33e4cfc9946eda7df914027a3d1fc94d17008dff2ae4f8c6c27d1ad2edffb88";
const EXPECTED_EXPORT_RUN_ROOT = resolve(
  repoRoot,
  "target/test/apps/kcoder-studio/e2e/private/mobile-workspace-catalog-snapshot-browser.once.e2e.mjs/20261009-215337.210Z",
);
const EXPORT_SOURCE_PATH = "apps/kcoder-studio/e2e/private/mobile-workspace-catalog-snapshot-browser.once.e2e.mjs";
const BROWSER_SOURCE_PATH = "apps/kcoder-studio/e2e/private/mobile-workspace-catalog-snapshot-browser-bridgefix.once.e2e.mjs";
const FROZEN_PRODUCT_PATHS = Object.freeze([
  "apps/kcoder-studio/mobile/src/runtime/task-runtime/workspaces.ts",
  "apps/kcoder-studio/mobile/src/app/open-project.tsx",
  "apps/kcoder-studio/mobile/src/runtime/task-runtime.catalog-snapshot-v1.review.test.ts",
]);
const EXPORT_SUPPORT_PATHS = Object.freeze([
  "apps/kcoder-studio/mobile/package-lock.json",
  "apps/kcoder-studio/mobile/scripts/gateway-mobile-web-manifest.mjs",
  "apps/kcoder-studio/dev-server.mjs",
  "apps/kcoder-studio/src/mobile-web-static.js",
  "apps/kcoder-studio/e2e/harness/mobile-web-export.mjs",
  "apps/kcoder-studio/e2e/harness/mobile-web-export-input.mjs",
  "apps/kcoder-studio/e2e/harness/mobile-web-export-reuse.mjs",
  "apps/kcoder-studio/e2e/harness/run-context.mjs",
  "apps/kcoder-studio/e2e/harness/gateway.mjs",
  "apps/kcoder-studio/e2e/harness/chromium.mjs",
]);
const BROWSER_SUPPORT_PATHS = Object.freeze(
  EXPORT_SUPPORT_PATHS.filter(path => path !== "apps/kcoder-studio/mobile/scripts/gateway-mobile-web-manifest.mjs"),
);
const EXCLUDED_SOURCE_DIRECTORIES = new Set([".expo", ".git", "dist", "node_modules"]);
const NODE_VERSION = "v22.17.0";

assert.equal(resolve(repoRoot), EXPECTED_REPO_ROOT, "preparation must remain scoped to F");
assert.equal(resolve(appRoot), resolve(EXPECTED_REPO_ROOT, "apps/kcoder-studio"));
assert.equal(process.version, NODE_VERSION, "preparation requires fixed Node 22.17.0");
assert.equal(await realpath(process.execPath), EXPECTED_NODE_PATH, "preparation requires the fixed Node binary");

const options = parseOptions(process.argv.slice(2));
const exportRunRoot = resolve(requiredOption(options, "export-run-root"));
assert.equal(exportRunRoot, EXPECTED_EXPORT_RUN_ROOT, "only the exact retained current export run may be recovered");
assert.equal(await realpath(exportRunRoot), exportRunRoot, "the retained exporter run root must not traverse a symlink");
const scriptPath = resolve(fileURLToPath(import.meta.url));
const preparationSourceSha256 = await sha256File(scriptPath);

await runE2E(import.meta.url, {
  testId: "mobile-workspace-catalog-snapshot-prepare-deploy-bundle",
  tier: "manual-live",
  modelPolicy: "reuse current completed Expo output; generate the official Gateway manifest; no rebuild, Gateway, Browser, Provider, or native runtime",
  retainSuccessLogs: true,
}, async context => {
  const exportRunManifestPath = resolve(exportRunRoot, "manifest.json");
  const exportRunResultPath = resolve(exportRunRoot, "artifacts/result.json");
  const exportRunManifestBytes = await readRegularFile(exportRunManifestPath);
  const exportRunResultBytes = await readRegularFile(exportRunResultPath);
  const exportRunManifest = JSON.parse(exportRunManifestBytes.toString("utf8"));
  const exportRunResult = JSON.parse(exportRunResultBytes.toString("utf8"));
  assert.equal(exportRunManifest.status, "failed",
    "the original RunContext result must remain an honest failure after its bad postcondition");
  assert.equal(exportRunResult.status, "failed");
  assert.match(exportRunManifest.error ?? "", /kcoder-mobile-web\.json/,
    "the retained failure must be the known raw-Expo-versus-Gateway-manifest postcondition");
  assert.ok(exportRunManifest.processes.length >= 3);
  assert.ok(exportRunManifest.processes.every(process => process.stopped),
    "all original exporter child process groups must be stopped");
  assert.ok(exportRunManifest.cleanupSteps.length >= 3 && exportRunManifest.cleanupSteps.every(step => step.status === "completed"),
    "all original exporter cleanup steps must have completed");

  const exporterManifestPath = resolve(
    exportRunRoot,
    "artifacts/mobile-web-export-workspace-catalog-frozen-mobile-manifest.json",
  );
  const exporterManifestBytes = await readRegularFile(exporterManifestPath);
  const exporterManifestSha256 = sha256(exporterManifestBytes);
  const exporterManifest = JSON.parse(exporterManifestBytes.toString("utf8"));
  verifyMobileExportManifestEnvelope(
    exporterManifest,
    exporterManifestBytes,
    exporterManifestSha256,
    "recovered current Expo output",
  );
  assert.equal(exporterManifest.deployMount, true);
  assert.equal(exporterManifest.sourceUnchanged, true);
  assert.equal(exporterManifest.snapshotCopyMatchesSource, true);
  assert.equal(exporterManifest.terminalHookChangesOnlyGeneratedHtml, true);
  assert.equal(exporterManifest.snapshotUnchangedDuringExport, true);
  assert.equal(exporterManifest.dependencyProvenance.sourceUnchanged, true);
  assert.equal(
    exporterManifest.dependencyProvenance.sourceTreeSha256Before,
    exporterManifest.dependencyProvenance.sourceTreeSha256After,
  );
  assert.match(exporterManifest.dependencyProvenance.copiedTreeSha256 ?? "", /^[a-f0-9]{64}$/);

  const freeze = await readFreezeEvidence();
  const productPins = await readProductPins(freeze.productPins);
  const sourceTree = await hashMobileSharedSources();
  assert.equal(sourceTree.sha256, exporterManifest.sourceTreeSha256,
    "the current full Mobile/shared source tree must match the bytes used by Expo export");
  assert.deepEqual(sourceTree.roots, exporterManifest.inputRoots,
    "per-root Mobile/shared source inventories must match the Expo exporter manifest");
  const preparationSupportPins = await readSupportPins(EXPORT_SUPPORT_PATHS);
  const supportingSourcePins = Object.fromEntries(
    Object.entries(preparationSupportPins).filter(([path]) => BROWSER_SUPPORT_PATHS.includes(path)),
  );
  assert.equal(preparationSupportPins["apps/kcoder-studio/e2e/harness/chromium.mjs"], EXPECTED_CHROMIUM_HELPER_SHA256,
    "the Chromium helper must match its independently frozen source revision");

  const exportPhaseSourcePath = resolve(exportRunRoot, "artifacts/export-phase-source.mjs");
  const exportPhaseSourceBytes = await readRegularFile(exportPhaseSourcePath);
  const exportPhaseSourceSha256 = sha256(exportPhaseSourceBytes);
  assert.equal(exportPhaseSourceSha256, "e5aae81b363c12c3daa051e3950812c14d1472e238834908c6dbc333667cd55f",
    "the source revision used to run export must match its retained copy");
  const browserPhaseSourcePath = resolve(repoRoot, BROWSER_SOURCE_PATH);
  const browserPhaseSourceSha256 = await sha256File(browserPhaseSourcePath);
  const browserRevisionDiff = await captureSourceDiff(context, exportPhaseSourcePath, browserPhaseSourcePath);
  assert.ok(browserRevisionDiff.diffText.includes("websocket-close-forward-started"));
  assert.ok(browserRevisionDiff.diffText.includes("catalogSocketsClosedBothSides"));
  assert.ok(!browserRevisionDiff.diffText.includes("workspacePath: \"/tmp/mobile-catalog-browser/workspace\""),
    "the bridge-only browser revision must preserve directory fixtures");
  const browserRevisionDiffArtifactPath = await context.writeArtifactJson("browser-bridge-source-diff.json", {
    schemaVersion: 1,
    scope: "WebSocketRoute close propagation and waiting for both owned transport endpoints; no product source or bundle bytes changed",
    exportPhaseSourcePath,
    exportPhaseSourceSha256,
    browserPhaseSourcePath,
    browserPhaseSourceSha256,
    diffCommand: browserRevisionDiff.argv,
    diffExitCode: browserRevisionDiff.exitCode,
    diffText: browserRevisionDiff.diffText,
  });
  const browserRevisionDiffArtifactBytes = await readFile(browserRevisionDiffArtifactPath);
  const browserRevisionDiffSha256 = sha256(browserRevisionDiffArtifactBytes);

  const rawBundlePath = resolve(exportRunRoot, "artifacts/mobile-web-bundle");
  const rawBundleRows = await collectBundleRows(rawBundlePath);
  assert.deepEqual(rawBundleRows, exporterManifest.bundleFiles,
    "the retained raw Expo bundle must exactly match its complete 37-resource exporter inventory");
  assert.equal(hashJson(rawBundleRows), exporterManifest.bundleSha256);

  const deploymentBundlePath = context.pathInArtifacts("mobile-web-bundle");
  await mkdir(deploymentBundlePath, { recursive: false, mode: 0o700 });
  await cp(rawBundlePath, deploymentBundlePath, { recursive: true, errorOnExist: true, force: false });
  const preManifestRows = await collectBundleRows(deploymentBundlePath);
  assert.deepEqual(preManifestRows, exporterManifest.bundleFiles,
    "the deployment copy must begin as an exact copy of the raw 37-resource Expo output");
  const gatewayManifest = await buildGatewayMobileWebManifest(deploymentBundlePath, {
    expectedFiles: exporterManifest.bundleFiles,
  });
  await writeGatewayMobileWebManifest(deploymentBundlePath, gatewayManifest);
  const gatewayManifestPath = resolve(deploymentBundlePath, "kcoder-mobile-web.json");
  const gatewayManifestBytes = await readRegularFile(gatewayManifestPath);
  const gatewayManifestOnDisk = JSON.parse(gatewayManifestBytes.toString("utf8"));
  assert.deepEqual(gatewayManifestOnDisk, gatewayManifest,
    "the build-owned production Gateway manifest must be materialized by the official Mobile builder");
  assert.equal(gatewayManifest.version, 1);
  assert.equal(gatewayManifest.files.length, exporterManifest.bundleFileCount);
  assert.equal(gatewayManifest.files.length, 37,
    "the Gateway manifest indexes 37 published assets and is the separate 38th package file");

  const deploymentBundleRows = await collectBundleRows(deploymentBundlePath);
  assert.equal(deploymentBundleRows.length, exporterManifest.bundleFileCount + 1,
    "the deployable package must contain 37 Expo resources plus the production Gateway manifest");
  const deploymentBundleSha256 = hashJson(deploymentBundleRows);
  const retainedManifestPath = await context.writeArtifactJson("mobile-workspace-catalog-retained-export.json", {
    schemaVersion: 1,
    purpose: "current frozen Mobile workspace catalog bundle prepared for the real Gateway /mobile/ mount",
    sourceCommit: exportRunManifest.gitCommit,
    sourceTreeSha256: exporterManifest.sourceTreeSha256,
    bundleSha256: deploymentBundleSha256,
    bundleFileCount: deploymentBundleRows.length,
    indexHtmlSha256: exporterManifest.indexHtmlSha256,
    directory: relative(context.runRoot, deploymentBundlePath).split(sep).join("/"),
    files: deploymentBundleRows,
  });
  const retainedManifestSha256 = sha256(await readFile(retainedManifestPath));
  const dependencyRoot = exporterManifest.dependencyProvenance.sourceRoot;
  assert.equal(await realpath(dependencyRoot), dependencyRoot,
    "the export dependency source path must remain its recorded canonical F Mobile install tree");
  const expoPackageBytes = await readRegularFile(resolve(dependencyRoot, "expo/package.json"));
  const expoPackage = JSON.parse(expoPackageBytes.toString("utf8"));
  const dependencyProvenance = exporterManifest.dependencyProvenance;

  const handoff = {
    schemaVersion: 1,
    phase: "export",
    status: "PASS",
    statusScope: "the retained complete Expo output was revalidated and prepared as a deployable Gateway bundle; the original export RunContext remains failed due to its incorrect missing-manifest assertion",
    evidenceClass: "current frozen Mobile/shared source exported by the harness, then prepared with the official Gateway Mobile Web manifest builder; no Gateway/Browser/Provider/native runtime in this phase",
    source: {
      headFromFreezeEvidence: freeze.head,
      runContextHead: exportRunManifest.gitCommit,
      headRelationship: "RunContext HEAD may include unrelated commits; product source identity is frozen verification evidence plus three source hashes and the exporter full Mobile/shared content digest",
      freezeEvidencePath: freeze.path,
      freezeEvidenceSha256: freeze.sha256,
      productFilePins: productPins,
      sourceTreeSha256: exporterManifest.sourceTreeSha256,
      inputRoots: exporterManifest.inputRoots,
      testSourceSha256: exportPhaseSourceSha256,
      exportPhaseSourcePath,
      browserPhaseTestSourceSha256: browserPhaseSourceSha256,
      browserPhaseSourcePath,
      browserRevisionScope: "WebSocketRoute close propagation and waiting for both owned transport endpoints; frozen Mobile product source, directory fixtures, Expo output, and dependencies are unchanged",
      browserRevisionDiffPath: browserRevisionDiffArtifactPath,
      browserRevisionDiffSha256,
      currentFullSourceRehashAtPreparation: sourceTree.sha256,
    },
    dependencies: {
      root: dependencyRoot,
      sourceTreeSha256: dependencyProvenance.sourceTreeSha256Before,
      sourceTreeSha256Before: dependencyProvenance.sourceTreeSha256Before,
      sourceTreeSha256After: dependencyProvenance.sourceTreeSha256After,
      ownedTreeSha256: dependencyProvenance.copiedTreeSha256,
      lockSha256: supportingSourcePins["apps/kcoder-studio/mobile/package-lock.json"],
      expoVersion: expoPackage.version,
      expoPackageJsonSha256: sha256(expoPackageBytes),
      sourceBeforeAfterHashAlgorithm: "exportMobileWeb collectTree with includeNodeModules=true and symlink entries hashed as link targets",
      ownedCopyHashAlgorithm: "exportMobileWeb hash of cp -aL dereferenced copy with rejectSymlinks=true",
      sourceAndOwnedDigestsAreRecordedSeparately: true,
      sourceAndOwnedDigestsAreNotAssertedEqual: true,
      sourceBeforeEqualsSourceAfter: dependencyProvenance.sourceUnchanged,
      dependencyCopierPid: dependencyProvenance.copierPid,
      copiedFileCount: dependencyProvenance.copiedFileCount,
      copiedSymlinks: dependencyProvenance.copiedSymlinks,
    },
    export: {
      originalExportRunRoot: exportRunRoot,
      originalExportRunManifestPath: exportRunManifestPath,
      originalExportRunManifestSha256: sha256(exportRunManifestBytes),
      originalExportRunStatus: exportRunManifest.status,
      originalExportRunResultStatus: exportRunResult.status,
      originalExportRunFailure: exportRunManifest.error,
      originalExportProcesses: exportRunManifest.processes,
      originalExportCleanupSteps: exportRunManifest.cleanupSteps,
      expoExportOutcome: exporterManifest.status,
      exporterManifestPath,
      exporterManifestSha256,
      rawExpoBundlePath: rawBundlePath,
      rawExpoBundleSha256: exporterManifest.bundleSha256,
      rawExpoBundleFileCount: exporterManifest.bundleFileCount,
      rawExpoBundleFiles: exporterManifest.bundleFiles,
      deployBundleRoot: deploymentBundlePath,
      deployBundleSha256: deploymentBundleSha256,
      deployBundleFileCount: deploymentBundleRows.length,
      gatewayManifestPath,
      gatewayManifestSha256: sha256(gatewayManifestBytes),
      gatewayManifestResourceCount: gatewayManifest.files.length,
      deployMount: true,
      indexHtmlSha256: exporterManifest.indexHtmlSha256,
      processPids: {
        dependencyCopy: dependencyProvenance.copierPid,
        terminalHtmlBuild: exporterManifest.terminalWebView.builderPid,
        expoExport: exporterManifest.exporterPid,
      },
      originalExporterManifestBundleCountExcludesGatewayManifest: true,
      retainedBundlePath: deploymentBundlePath,
      retainedManifestPath,
      retainedManifestSha256,
      bundleSha256: deploymentBundleSha256,
      bundleFileCount: deploymentBundleRows.length,
    },
    supportingSourcePins,
    preparation: {
      argv: process.argv,
      runContextHead: context.gitCommit,
      runContextRoot: context.runRoot,
      gatewayManifestBuilder: "Mobile scripts/gateway-mobile-web-manifest.mjs buildGatewayMobileWebManifest + writeGatewayMobileWebManifest",
      gatewayManifestBuilderSha256: preparationSupportPins["apps/kcoder-studio/mobile/scripts/gateway-mobile-web-manifest.mjs"],
      supportPinsReadAfterExport: true,
      supportPinTimingBoundary: "Gateway manifest builder and browser support hashes were captured during preparation after the original Expo export; original exporter source, dependencies, and full Mobile/shared digest come from the preserved export manifest",
      gatewayManifestBuilderSourcePath: "apps/kcoder-studio/mobile/scripts/gateway-mobile-web-manifest.mjs",
      browserPhaseSupportPins: supportingSourcePins,
      credentialHandling: "No Gateway auth token was created; no environment, credentials, browser trace, or request payload was captured",
    },
  };
  assert.equal(await sha256File(scriptPath), preparationSourceSha256,
    "the preparation source changed while assembling the deploy bundle handoff");
  handoff.preparation.sourcePath = scriptPath;
  handoff.preparation.sourceSha256 = preparationSourceSha256;
  const handoffPath = await context.writeArtifactJson("mobile-workspace-catalog-export.json", handoff);
  return {
    handoffPath,
    handoffSha256: sha256(await readFile(handoffPath)),
    retainedManifestPath,
    retainedManifestSha256,
    deployBundlePath: deploymentBundlePath,
    deployBundleSha256: deploymentBundleSha256,
    deployBundleFileCount: deploymentBundleRows.length,
    gatewayManifestSha256: sha256(gatewayManifestBytes),
    sourceTreeSha256: exporterManifest.sourceTreeSha256,
    dependencySourceTreeSha256: dependencyProvenance.sourceTreeSha256Before,
    dependencyOwnedTreeSha256: dependencyProvenance.copiedTreeSha256,
  };
});

async function captureSourceDiff(context, originalPath, browserPath) {
  const diffBinaryPath = await realpath("/usr/bin/diff");
  const argv = [
    diffBinaryPath,
    "-u",
    "--label=export-phase-source.mjs",
    originalPath,
    "--label=browser-phase-source.mjs",
    browserPath,
  ];
  const child = context.spawnOwned("browser-bridge-source-diff", diffBinaryPath, argv.slice(1), {
    cwd: repoRoot,
  });
  const chunks = [];
  let byteCount = 0;
  child.stdout.on("data", chunk => {
    byteCount += chunk.length;
    if (byteCount <= 256 * 1024) chunks.push(Buffer.from(chunk));
  });
  await waitFor(
    () => child.spawnError || child.exitCode !== null || child.signalCode !== null,
    10_000,
    "browser bridge source diff",
    25,
    context.abortSignal,
  );
  const exitCode = child.exitCode;
  await context.stopOwned("browser-bridge-source-diff");
  assert.equal(byteCount <= 256 * 1024, true, "browser source diff exceeds its artifact bound");
  assert.equal(exitCode, 1, "browser source must contain a reviewable bridge-only patch");
  const diffText = Buffer.concat(chunks).toString("utf8");
  assert.ok(diffText.length > 0);
  return { argv, exitCode, diffText };
}

async function hashMobileSharedSources() {
  const roots = [
    { name: "mobile", path: resolve(repoRoot, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: resolve(repoRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
  ];
  const hashedRoots = [];
  for (const root of roots) {
    assert.equal(await realpath(root.path), root.path);
    const files = await collectSourceTree(root.path);
    hashedRoots.push({
      name: root.name,
      sourceRoot: root.path,
      destination: root.destination,
      sha256: hashJson(files),
      fileCount: files.length,
    });
  }
  return {
    roots: hashedRoots,
    sha256: hashJson(hashedRoots.map(({ name, destination, sha256: digest }) => ({ name, destination, sha256: digest }))),
  };
}

async function collectSourceTree(root) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (shouldOmitSourceEntry(child.name)) continue;
      const absolutePath = resolve(directory, child.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        entries.push({ path: relativePath, type: "symlink", target: await readlink(absolutePath) });
      } else if (info.isDirectory()) {
        if (EXCLUDED_SOURCE_DIRECTORIES.has(child.name)) continue;
        await visit(absolutePath);
      } else if (info.isFile()) {
        const bytes = await readFile(absolutePath);
        entries.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

function shouldOmitSourceEntry(name) {
  if (EXCLUDED_SOURCE_DIRECTORIES.has(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  return /(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name);
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
      assert.ok(!info.isSymbolicLink(), "Mobile Web bundle must not contain symlinks");
      if (info.isDirectory()) {
        await visit(path);
      } else {
        assert.ok(info.isFile(), "Mobile Web bundle must only contain regular files");
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

async function readFreezeEvidence() {
  const path = resolve(repoRoot, "target/private-phone-workspace-catalog-20261009/verification.json");
  const bytes = await readRegularFile(path);
  const digest = sha256(bytes);
  assert.equal(digest, EXPECTED_FREEZE_EVIDENCE_SHA256, "the source freeze evidence changed");
  const evidence = JSON.parse(bytes.toString("utf8"));
  assert.equal(evidence.head, "2ad3474ceaad33646cc7b4fee7b03934f1bb9c79");
  const productPins = {};
  for (const pathName of FROZEN_PRODUCT_PATHS) {
    const expected = evidence.files[pathName]?.sha256;
    assert.match(expected ?? "", /^[a-f0-9]{64}$/);
    productPins[pathName] = expected;
  }
  const reviewPath = "apps/kcoder-studio/mobile/src/runtime/task-runtime.catalog-snapshot-v1.review.test.ts";
  assert.match(evidence.sourceBeforeStatus?.[reviewPath] ?? "", /absent at HEAD/);
  assert.equal(evidence.validation.find(row => row.exitCode === 0 && row.filesPassed === 5)?.testsPassed, 38);
  assert.ok(evidence.validation.some(row => row.command === "node_modules/.bin/tsc --noEmit -p tsconfig.json" && row.exitCode === 0));
  return { path, sha256: digest, head: evidence.head, productPins };
}

async function readProductPins(frozenPins) {
  const pins = {};
  for (const path of FROZEN_PRODUCT_PATHS) {
    const actual = await sha256File(resolve(repoRoot, path));
    assert.equal(actual, frozenPins[path], "frozen Mobile product source changed: " + path);
    pins[path] = actual;
  }
  return pins;
}

async function readSupportPins(paths) {
  const pins = {};
  for (const path of paths) pins[path] = await sha256File(resolve(repoRoot, path));
  return pins;
}

async function readRegularFile(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "evidence input must be a regular non-symlink file");
  return readFile(path);
}

async function sha256File(path) {
  return sha256(await readRegularFile(path));
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    assert.match(key, /^--[a-z][a-z0-9-]*$/);
    assert.ok(index + 1 < args.length, "missing value for " + key);
    assert.ok(!Object.hasOwn(options, key.slice(2)), "duplicate option " + key);
    options[key.slice(2)] = args[++index];
  }
  return options;
}

function requiredOption(values, key) {
  const value = values[key];
  assert.ok(typeof value === "string" && value.length > 0, "required option --" + key);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}
