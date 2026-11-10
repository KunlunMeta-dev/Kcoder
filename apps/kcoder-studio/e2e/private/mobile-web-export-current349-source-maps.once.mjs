// One-shot source-map diagnostic export for the pinned Mobile Web worktree.
// This preserves the official 37-file deployment as a separate immutable input.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { verifySourceMapBundleEvidence } from "../harness/render-profile-attribution-contract.mjs";
import { appRoot, repoRoot, runE2E } from "../harness/run-context.mjs";

const execFileAsync = promisify(execFile);
const TEST_ID = "mobile-web-export-current-source-diagnostic-20261009";
const SOURCE_PARITY_REFERENCE_COMMIT = "079ea127b713313f4d41deb20fefb6f93053efe4";
const MOBILE_ROOT = resolve(appRoot, "mobile");
const SHARED_ROOT = resolve(appRoot, "shared");
const DEPENDENCY_ROOT = resolve(MOBILE_ROOT, "node_modules");
const DEPENDENCY_LOCK_PATH = resolve(MOBILE_ROOT, "package-lock.json");
const EXPECTED_DEPENDENCY_LOCK_SHA256 = "7c47b7ad5427ac56682f19c6fb7e46cff6e442ad8f52edee283665a38cd2e68b";
const NODE_PATH = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const NODE_VERSION = "v22.17.0";
const NODE_SHA256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const OFFICIAL_DIST_ROOT = resolve(repoRoot, "target/worktree/2026/10/09/mobile-ux-all-changes-20261009/apps/kcoder-studio/mobile/dist");
const OFFICIAL_DIST_MANIFEST = resolve(OFFICIAL_DIST_ROOT, "kcoder-mobile-web.json");
const OFFICIAL_DIST_MANIFEST_SHA256 = "5053ac22d3476f7f17513a3c76a71b8993f3752e47bd060b8bead5c07c830752";
const OFFICIAL_ENTRY_SHA256 = "3d4f4c7708c41170474b714afcee5fec6fd5d6a4e28185f188f3b04b5767f338";
const OUTPUT_PARENT = resolve(repoRoot, "target/private-phone-ux-implementation");
const OUTPUT_PACKAGE_ROOT = resolve(OUTPUT_PARENT, "mobile-web-export-current-source-diagnostic-20261009");
const OUTPUT_BUNDLE_ROOT = resolve(OUTPUT_PACKAGE_ROOT, "bundle");
const OUTPUT_MANIFEST_PATH = resolve(OUTPUT_PACKAGE_ROOT, "export-manifest.json");
const OUTPUT_SOURCE_MANIFEST_PATH = resolve(OUTPUT_PACKAGE_ROOT, "source-manifest.json");
const OUTPUT_PROVENANCE_PATH = resolve(OUTPUT_PACKAGE_ROOT, "provenance.json");
const BASE_TOKEN = "/__kcoder_mobile_mount_v1__";
const MOBILE_SOURCE_PATH = "apps/kcoder-studio/mobile";
const SHARED_SOURCE_PATH = "apps/kcoder-studio/shared";
const RENAMED_NODE_MODULES_PREFIX = "assets/_____apps/kcoder-studio/mobile/node_modules/";
const DIAGNOSTIC_NODE_MODULES_PREFIX = "assets/node_modules/";
const TEXT_EXTENSIONS = new Set([".js", ".css", ".json", ".html", ".svg", ".txt", ".xml", ".webmanifest"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function checkedRelativePath(value, label) {
  assert.equal(typeof value, "string", `${label} path must be a string`);
  assert.ok(value.length > 0 && !value.startsWith("/") && !value.includes("\\"), `${label} path must be relative`);
  const parts = value.split("/");
  assert.ok(parts.every((part) => part && part !== "." && part !== ".."), `${label} path contains traversal`);
  return parts;
}

async function assertRealDirectory(path, label) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a real directory`);
  assert.equal(await realpath(path), resolve(path), `${label} must be canonical`);
  return info;
}

async function assertAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.fail(`${label} already exists; refusing to overwrite it`);
}

async function readRegularFile(path, label) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  const bytes = await readFile(path);
  assert.equal(bytes.length, info.size, `${label} changed while being read`);
  return { bytes, info };
}

async function collectFiles(root, { excludeManifest = false } = {}) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = resolve(directory, child.name);
      const path = relative(root, absolutePath).split(sep).join("/");
      if (excludeManifest && path === "kcoder-mobile-web.json") continue;
      const info = await lstat(absolutePath);
      assert.ok(!info.isSymbolicLink(), `bundle contains a symlink: ${path}`);
      if (info.isDirectory()) {
        await visit(absolutePath);
      } else {
        assert.ok(info.isFile(), `bundle contains a special file: ${path}`);
        const bytes = await readFile(absolutePath);
        entries.push({ path, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

async function readOfficialDist() {
  await assertRealDirectory(OFFICIAL_DIST_ROOT, "official current Mobile Web dist");
  const manifestFile = await readRegularFile(OFFICIAL_DIST_MANIFEST, "official dist manifest");
  assert.equal(sha256(manifestFile.bytes), OFFICIAL_DIST_MANIFEST_SHA256, "official dist manifest digest changed");
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.baseToken, BASE_TOKEN);
  assert.equal(manifest.files.length, 37, "official dist must remain the verified 37-file package");
  assert.equal(manifest.files.filter((entry) => entry.path.endsWith(".map")).length, 0, "official dist must remain map-free");
  const actualFiles = await collectFiles(OFFICIAL_DIST_ROOT, { excludeManifest: true });
  assert.equal(actualFiles.length, manifest.files.length, "official dist file count differs from its manifest");
  const expectedByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const entry of actualFiles) {
    const expected = expectedByPath.get(entry.path);
    assert.ok(expected, `official dist has an unmanifested file: ${entry.path}`);
    assert.equal(entry.size, expected.size, `official dist size changed: ${entry.path}`);
    assert.equal(entry.sha256, expected.sha256, `official dist file changed: ${entry.path}`);
  }
  const entry = manifest.files.find((file) => file.path.endsWith(".js") && file.path.includes("/entry-"));
  assert.ok(entry, "official dist entry bundle is missing");
  assert.equal(entry.sha256, OFFICIAL_ENTRY_SHA256, "official dist JavaScript entry digest changed");
  return {
    manifest,
    manifestSha256: sha256(manifestFile.bytes),
    files: actualFiles,
    bundleSha256: hashJson(actualFiles),
    entry,
  };
}

async function verifyInputs() {
  assert.equal(process.execPath, NODE_PATH, "run with the pinned Node 22.17 executable");
  assert.equal(process.version, NODE_VERSION, "Node version changed");
  assert.equal(sha256(await readFile(process.execPath)), NODE_SHA256, "pinned Node binary changed");
  const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5_000,
  });
  const currentSourceCommit = head.trim();
  const { stdout: parityReference } = await execFileAsync("git", ["rev-parse", `${SOURCE_PARITY_REFERENCE_COMMIT}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(parityReference.trim(), SOURCE_PARITY_REFERENCE_COMMIT, "Mobile/Shared source parity reference changed");
  const { stdout: currentTreeOutput } = await execFileAsync("git", [
    "rev-parse", `HEAD:${MOBILE_SOURCE_PATH}`, `HEAD:${SHARED_SOURCE_PATH}`,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5_000,
  });
  const { stdout: referenceTreeOutput } = await execFileAsync("git", [
    "rev-parse", `${SOURCE_PARITY_REFERENCE_COMMIT}:${MOBILE_SOURCE_PATH}`, `${SOURCE_PARITY_REFERENCE_COMMIT}:${SHARED_SOURCE_PATH}`,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5_000,
  });
  const currentGitTrees = currentTreeOutput.trim().split("\n");
  const referenceGitTrees = referenceTreeOutput.trim().split("\n");
  assert.equal(currentGitTrees.length, 2, "current Mobile/Shared Git tree inventory is incomplete");
  assert.deepEqual(currentGitTrees, referenceGitTrees, "current Mobile/Shared Git trees differ from the approved 079ea127 source parity reference");
  const { stdout: status } = await execFileAsync("git", [
    "status", "--porcelain", "--untracked-files=all", "--",
    "apps/kcoder-studio/mobile", "apps/kcoder-studio/shared",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(status.trim(), "", "Mobile/shared source roots contain uncommitted or untracked files");
  await assertRealDirectory(MOBILE_ROOT, "Mobile source root");
  await assertRealDirectory(SHARED_ROOT, "Studio shared source root");
  const resolvedDependencyRoot = await realpath(DEPENDENCY_ROOT);
  await assertRealDirectory(resolvedDependencyRoot, "canonical installed Mobile dependency root");
  await readRegularFile(resolve(resolvedDependencyRoot, "expo/package.json"), "installed Expo package manifest");
  const lock = await readRegularFile(DEPENDENCY_LOCK_PATH, "Mobile dependency lock");
  assert.equal(sha256(lock.bytes), EXPECTED_DEPENDENCY_LOCK_SHA256, "Mobile dependency lock digest changed");
  const official = await readOfficialDist();
  await assertAbsent(OUTPUT_PACKAGE_ROOT, "current-source diagnostic package");
  return {
    sourceCommit: currentSourceCommit,
    sourceParityReference: {
      commit: parityReference.trim(),
      currentMobileGitTree: currentGitTrees[0],
      currentSharedGitTree: currentGitTrees[1],
      referenceMobileGitTree: referenceGitTrees[0],
      referenceSharedGitTree: referenceGitTrees[1],
      workingTreesClean: true,
    },
    mobileRoot: MOBILE_ROOT,
    sharedRoot: SHARED_ROOT,
    dependencyRoot: resolvedDependencyRoot,
    dependencyLockSha256: sha256(lock.bytes),
    officialDistRoot: OFFICIAL_DIST_ROOT,
    officialDistManifestSha256: official.manifestSha256,
    officialDistBundleSha256: official.bundleSha256,
    officialDistFileCount: official.files.length,
    officialEntry: official.entry,
    outputPackageRoot: OUTPUT_PACKAGE_ROOT,
    node: { executable: NODE_PATH, version: NODE_VERSION, sha256: NODE_SHA256 },
  };
}

function stripSourceMapTrailer(bytes) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) return null;
  const trailer = /(?:\r?\n)(?:(?:\/\/# sourceMappingURL=[^\r\n]*|\/\/# debugId=[a-zA-Z0-9-]+)(?:\r?\n)?)+$/;
  const match = trailer.exec(text);
  if (!match) return null;
  const trailerLines = match[0].split(/\r?\n/).filter(Boolean);
  if (trailerLines.filter((line) => line.startsWith("//# sourceMappingURL=")).length !== 1) return null;
  if (trailerLines.some((line) => !/^\/\/# (?:sourceMappingURL=[^\r\n]*|debugId=[a-zA-Z0-9-]+)$/.test(line))) return null;
  return Buffer.from(text.slice(0, match.index));
}

async function compareWithOfficial(exported, official) {
  const regularEntries = exported.bundleFiles.filter((entry) => !entry.path.endsWith(".map"));
  const mapEntries = exported.bundleFiles.filter((entry) => entry.path.endsWith(".map"));
  assert.ok(mapEntries.length > 0, "source-map export did not produce map files");
  const officialByPath = new Map(official.files.map((entry) => [entry.path, entry]));
  const samePathComparisons = [];
  const javascriptComparisons = [];
  for (const entry of regularEntries) {
    const original = officialByPath.get(entry.path);
    if (original) {
      samePathComparisons.push({
        path: entry.path,
        diagnosticSize: entry.size,
        officialSize: original.size,
        diagnosticSha256: entry.sha256,
        officialSha256: original.sha256,
        byteIdentical: entry.size === original.size && entry.sha256 === original.sha256,
      });
    }
    if (entry.path.endsWith(".js") && original) {
      const diagnosticBytes = await readFile(resolve(exported.path, ...checkedRelativePath(entry.path, "diagnostic JavaScript asset")));
      const officialBytes = await readFile(resolve(OFFICIAL_DIST_ROOT, ...checkedRelativePath(original.path, "official JavaScript asset")));
      const diagnosticBody = stripSourceMapTrailer(diagnosticBytes);
      const officialBody = stripSourceMapTrailer(officialBytes) ?? officialBytes;
      javascriptComparisons.push({
        diagnosticPath: entry.path,
        officialPath: original.path,
        diagnosticSize: diagnosticBytes.length,
        officialSize: officialBytes.length,
        diagnosticSha256: sha256(diagnosticBytes),
        officialSha256: sha256(officialBytes),
        diagnosticBodySha256: diagnosticBody ? sha256(diagnosticBody) : null,
        officialBodySha256: sha256(officialBody),
        diagnosticBodyMatchesOfficial: diagnosticBody ? diagnosticBody.equals(officialBody) : null,
        fullFileByteIdentical: diagnosticBytes.equals(officialBytes),
        comparisonBy: "same-path-exact-bytes",
      });
    }
  }

  const diagnosticEntry = regularEntries.find((entry) => /\/entry-[^/]+\.js$/.test(entry.path));
  const officialEntry = official.files.find((entry) => /\/entry-[^/]+\.js$/.test(entry.path));
  assert.ok(diagnosticEntry && officialEntry, "diagnostic or official JavaScript entry is missing");
  if (diagnosticEntry.path !== officialEntry.path) {
    const diagnosticBytes = await readFile(resolve(exported.path, ...checkedRelativePath(diagnosticEntry.path, "diagnostic entry")));
    const officialBytes = await readFile(resolve(OFFICIAL_DIST_ROOT, ...checkedRelativePath(officialEntry.path, "official entry")));
    const diagnosticBody = stripSourceMapTrailer(diagnosticBytes);
    const officialBody = stripSourceMapTrailer(officialBytes) ?? officialBytes;
    javascriptComparisons.push({
      diagnosticPath: diagnosticEntry.path,
      officialPath: officialEntry.path,
      diagnosticSize: diagnosticBytes.length,
      officialSize: officialBytes.length,
      diagnosticSha256: sha256(diagnosticBytes),
      officialSha256: sha256(officialBytes),
      diagnosticBodySha256: diagnosticBody ? sha256(diagnosticBody) : null,
      officialBodySha256: sha256(officialBody),
      diagnosticBodyMatchesOfficial: diagnosticBody ? diagnosticBody.equals(officialBody) : null,
      fullFileByteIdentical: diagnosticBytes.equals(officialBytes),
      comparisonBy: "entry-role-not-path-equivalence",
    });
  }

  const renamedAssetComparisons = [];
  for (const entry of regularEntries) {
    if (!entry.path.startsWith(DIAGNOSTIC_NODE_MODULES_PREFIX)) continue;
    const officialPath = `${RENAMED_NODE_MODULES_PREFIX}${entry.path.slice(DIAGNOSTIC_NODE_MODULES_PREFIX.length)}`;
    const original = officialByPath.get(officialPath);
    if (!original) continue;
    const diagnosticBytes = await readFile(resolve(exported.path, ...checkedRelativePath(entry.path, "diagnostic renamed asset")));
    const officialBytes = await readFile(resolve(OFFICIAL_DIST_ROOT, ...checkedRelativePath(officialPath, "official renamed asset")));
    renamedAssetComparisons.push({
      diagnosticPath: entry.path,
      officialPath,
      diagnosticSize: diagnosticBytes.length,
      officialSize: officialBytes.length,
      diagnosticSha256: sha256(diagnosticBytes),
      officialSha256: sha256(officialBytes),
      byteIdentical: diagnosticBytes.equals(officialBytes),
    });
  }

  const diagnosticPaths = new Set(regularEntries.map((entry) => entry.path));
  const officialPaths = new Set(official.files.map((entry) => entry.path));
  const addedPaths = [...diagnosticPaths].filter((path) => !officialPaths.has(path)).sort();
  const removedPaths = [...officialPaths].filter((path) => !diagnosticPaths.has(path)).sort();
  const pairedDiagnosticPaths = new Set([diagnosticEntry.path, ...renamedAssetComparisons.map((entry) => entry.diagnosticPath)]);
  const pairedOfficialPaths = new Set([officialEntry.path, ...renamedAssetComparisons.map((entry) => entry.officialPath)]);
  let replacementCount = 0;
  for (const entry of regularEntries) {
    const extension = entry.path.slice(entry.path.lastIndexOf("."));
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const bytes = await readFile(resolve(exported.path, ...checkedRelativePath(entry.path, "map-enabled asset")));
    const text = bytes.toString("utf8");
    assert.ok(Buffer.from(text).equals(bytes), `text asset is not valid UTF-8: ${entry.path}`);
    replacementCount += text.split(BASE_TOKEN).length - 1;
  }
  const officialReplacementCount = official.manifest.files.reduce((sum, entry) => sum + (entry.replacements ?? 0), 0);
  assert.ok(replacementCount > 0, "deploy mount token was not applied to the map-enabled export");
  return {
    status: "diagnostic-comparison-recorded",
    officialEquivalence: "not-claimed",
    diagnosticRegularFileCount: regularEntries.length,
    officialRegularFileCount: official.files.length,
    regularFileCountMatches: regularEntries.length === official.files.length,
    exactPathSetMatch: addedPaths.length === 0 && removedPaths.length === 0,
    addedPaths,
    removedPaths,
    unpairedAddedPaths: addedPaths.filter((path) => !pairedDiagnosticPaths.has(path)),
    unpairedRemovedPaths: removedPaths.filter((path) => !pairedOfficialPaths.has(path)),
    samePathComparisons,
    samePathFilesByteIdentical: samePathComparisons.every((entry) => entry.byteIdentical),
    renamedNodeModuleAssetComparisons: renamedAssetComparisons,
    renamedNodeModuleAssetsByteIdentical: renamedAssetComparisons.length > 0 && renamedAssetComparisons.every((entry) => entry.byteIdentical),
    regularFileCount: regularEntries.length,
    mapFileCount: mapEntries.length,
    mapFiles: mapEntries,
    javascriptComparisons,
    deployMountTokenOccurrences: replacementCount,
    officialDeployMountTokenOccurrences: officialReplacementCount,
    deployMountTokenOccurrenceDelta: replacementCount - officialReplacementCount,
    officialEntrySha256: official.entry.sha256,
  };
}

async function copyBundle(sourceRoot, destinationRoot, files, expectedBundleSha256) {
  await assertAbsent(destinationRoot, "portable source-map bundle root");
  await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  const copied = [];
  for (const entry of files) {
    const source = resolve(sourceRoot, ...checkedRelativePath(entry.path, "exported bundle"));
    const destination = resolve(destinationRoot, ...checkedRelativePath(entry.path, "portable bundle"));
    const sourceInfo = await lstat(source);
    assert.ok(sourceInfo.isFile() && !sourceInfo.isSymbolicLink(), `exported bundle entry is not regular: ${entry.path}`);
    const bytes = await readFile(source);
    assert.equal(bytes.length, entry.size, `exported bundle size changed: ${entry.path}`);
    assert.equal(sha256(bytes), entry.sha256, `exported bundle entry changed: ${entry.path}`);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o444 });
    copied.push({ path: entry.path, size: bytes.length, sha256: sha256(bytes) });
  }
  copied.sort((left, right) => left.path.localeCompare(right.path));
  assert.equal(hashJson(copied), expectedBundleSha256, "portable source-map bundle differs from RunContext export");
  return copied;
}

async function makeTreeReadOnly(root) {
  for (const child of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, child.name);
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink(), "portable source-map package cannot contain symlinks");
    if (info.isDirectory()) {
      await makeTreeReadOnly(path);
      await chmod(path, 0o555);
    } else {
      assert.ok(info.isFile(), "portable source-map package cannot contain special files");
      await chmod(path, 0o444);
    }
  }
  await chmod(root, 0o555);
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 1 && ["--preflight", "--execute"].includes(args[0]),
    "usage: mobile-web-export-current349-source-maps.once.mjs --preflight|--execute");
  const inputs = await verifyInputs();
  if (args[0] === "--preflight") {
    console.log(JSON.stringify({ status: "preflight-ready", sourceMaps: true, deployMount: true, inputs }, null, 2));
    return;
  }

  const outputParentPath = resolve(OUTPUT_PARENT);
  await mkdir(outputParentPath, { recursive: true, mode: 0o700 });
  await assertRealDirectory(outputParentPath, "private source-map output parent");
  await assertAbsent(OUTPUT_PACKAGE_ROOT, "current-source diagnostic package");

  const result = await runE2E(import.meta.url, {
    testId: TEST_ID,
    tier: "manual-live",
    modelPolicy: "Current-source map-enabled Mobile Web diagnostic bundle; official-dist comparison is descriptive and this package is not a performance result",
    retainSuccessLogs: true,
    cleanupTimeoutMs: 20_000,
    survivorCheckTimeoutMs: 5_000,
    sourceCommit: inputs.sourceCommit,
    sourceParityReference: inputs.sourceParityReference,
    dependencyLockSha256: EXPECTED_DEPENDENCY_LOCK_SHA256,
    officialDistManifestSha256: OFFICIAL_DIST_MANIFEST_SHA256,
    sourceMaps: true,
    deployMount: true,
  }, async (context) => {
    await context.writeArtifactJson("current-source-diagnostic-inputs.json", inputs);
    const exported = await exportMobileWeb(context, {
      mobileRoot: MOBILE_ROOT,
      sourceRoots: [
        { name: "mobile", path: MOBILE_ROOT, destination: "apps/kcoder-studio/mobile" },
        { name: "studio-shared", path: SHARED_ROOT, destination: "apps/kcoder-studio/shared" },
      ],
      dependencyRoot: inputs.dependencyRoot,
      label: "current-source-diagnostic-20261009",
      outputName: "mobile-web-current-source-diagnostic-20261009",
      timeoutMs: 180_000,
      sourceMaps: true,
      deployMount: true,
    });
    const exportManifestBytes = await readFile(exported.bundleManifestPath);
    const exportManifest = JSON.parse(exportManifestBytes.toString("utf8"));
    const artifactBundleRoot = context.pathInArtifacts("current-source-diagnostic-bundle");
    const copiedArtifactFiles = await copyBundle(exported.path, artifactBundleRoot, exported.bundleFiles, exported.bundleSha256);
    const artifactManifestPath = context.pathInArtifacts("current-source-diagnostic-export-manifest.json");
    await writeFile(artifactManifestPath, exportManifestBytes, { flag: "wx", mode: 0o600 });
    await context.writeArtifactJson("current-source-diagnostic-bundle-pins.json", {
      bundleRoot: artifactBundleRoot,
      bundleSha256: exported.bundleSha256,
      bundleFileCount: exported.bundleFileCount,
      copiedFilesSha256: hashJson(copiedArtifactFiles),
      exporterManifestPath: artifactManifestPath,
      exporterManifestSha256: sha256(exportManifestBytes),
    });

    assert.equal(exportManifest.status, "complete", exportManifest.error || "source-map-enabled export must complete");
    assert.equal(exportManifest.deployMount, true, "Expo export manifest must record the deploy-mount option");
    assert.equal(exportManifest.sourceUnchanged, true);
    assert.equal(exportManifest.snapshotCopyMatchesSource, true);
    assert.equal(exportManifest.snapshotUnchangedDuringExport, true);
    assert.equal(exportManifest.dependencyProvenance.sourceUnchanged, true);
    assert.equal(exportManifest.terminalHookChangesOnlyGeneratedHtml, true);
    verifySourceMapBundleEvidence(exportManifest.sourceMapEvidence, exportManifest);

    const official = await readOfficialDist();
    const comparison = await compareWithOfficial({ ...exported, path: artifactBundleRoot }, official);
    const sourceFileCount = exported.sourceRoots.reduce((sum, root) => sum + root.fileCount, 0);
    const sourceRoots = exported.sourceRoots.map(({ name, sourceRoot, destination, sha256: digest, fileCount }) => ({
      name, sourceRoot, destination, sha256: digest, fileCount,
    }));
    const sourceManifest = {
      schemaVersion: 1,
      status: "complete",
      sourceCommit: inputs.sourceCommit,
      sourceParityReference: inputs.sourceParityReference,
      sourceWorktreeDirty: false,
      sourceTreeSha256: exported.sourceTreeSha256,
      sourceFileCount,
      roots: sourceRoots,
      sourceHashExclusions: exportManifest.sourceHashExclusions,
      dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
      dependencyLockSha256: EXPECTED_DEPENDENCY_LOCK_SHA256,
      meaning: "Per-root SHA-256 aggregates produced by exportMobileWeb for the clean pinned Git worktree; not a separate retained source copy.",
    };
    const sourceManifestBytes = Buffer.from(`${JSON.stringify(sourceManifest, null, 2)}\n`);
    const sourceManifestSha256 = sha256(sourceManifestBytes);

    const sourceProvenance = {
      schemaVersion: 1,
      status: "complete",
      purpose: "Private current-source diagnostic source-map bundle for full V8 render attribution; not a replacement for the official dist or a performance result.",
      frozenSourceManifestSha256: sourceManifestSha256,
      frozenSourceManifestPath: OUTPUT_SOURCE_MANIFEST_PATH,
      frozenSourceEntryCount: sourceFileCount,
      sourceTreeSha256: exported.sourceTreeSha256,
      sourceCommit: inputs.sourceCommit,
      sourceParityReference: inputs.sourceParityReference,
      sourceWorktreeDirty: false,
      sourceCompleteness: { manifestFileCount: sourceFileCount, workspaceComplementCopied: false },
      sourceComplementSha256: null,
      complementarySourceDescription: "Mobile and Studio shared roots were hashed and copied by the existing owned exportMobileWeb lifecycle.",
      sourceRoots,
      dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
      dependencyLockSha256: EXPECTED_DEPENDENCY_LOCK_SHA256,
      bundleManifest: OUTPUT_MANIFEST_PATH,
      bundlePath: OUTPUT_BUNDLE_ROOT,
      bundleSha256: exported.bundleSha256,
      sourceMapEvidence: exportManifest.sourceMapEvidence,
      exporterManifestSha256: sha256(exportManifestBytes),
      exporterSourceUnchanged: exportManifest.sourceUnchanged,
      snapshotCopyMatchesSource: exportManifest.snapshotCopyMatchesSource,
      snapshotUnchangedDuringExport: exportManifest.snapshotUnchangedDuringExport,
      terminalHookChangesOnlyGeneratedHtml: exportManifest.terminalHookChangesOnlyGeneratedHtml,
      deployMount: true,
      officialDistComparison: {
        manifestPath: OFFICIAL_DIST_MANIFEST,
        manifestSha256: official.manifestSha256,
        bundleSha256: official.bundleSha256,
        bundleFileCount: official.files.length,
        ...comparison,
      },
      credentialStateCopied: false,
      attributionBoundary: "Profiles must bind to this exact current-source diagnostic bundle and map digest. Official comparison records path and byte facts and does not claim this bundle is equivalent to the official dist.",
    };

    const stageRoot = context.pathInState("portable-current-source-diagnostic-package");
    await assertAbsent(stageRoot, "RunContext-owned portable source-map package");
    await mkdir(stageRoot, { recursive: false, mode: 0o700 });
    const stagedBundleRoot = resolve(stageRoot, "bundle");
    const copiedBundleFiles = await copyBundle(artifactBundleRoot, stagedBundleRoot, exported.bundleFiles, exported.bundleSha256);
    await writeFile(resolve(stageRoot, "export-manifest.json"), exportManifestBytes, { flag: "wx", mode: 0o600 });
    await writeFile(resolve(stageRoot, "source-manifest.json"), sourceManifestBytes, { flag: "wx", mode: 0o600 });
    const provenanceBytes = Buffer.from(`${JSON.stringify(sourceProvenance, null, 2)}\n`);
    await writeFile(resolve(stageRoot, "provenance.json"), provenanceBytes, { flag: "wx", mode: 0o600 });
    await context.writeArtifactJson("current-source-diagnostic-export-provenance.json", sourceProvenance);
    await makeTreeReadOnly(stageRoot);

    await assertAbsent(OUTPUT_PACKAGE_ROOT, "current-source diagnostic package");
    await rename(stageRoot, OUTPUT_PACKAGE_ROOT);
    const finalBundleFiles = await collectFiles(OUTPUT_BUNDLE_ROOT);
    assert.equal(hashJson(finalBundleFiles), exported.bundleSha256, "portable bundle differs after atomic publication");
    assert.equal(sha256(await readFile(OUTPUT_MANIFEST_PATH)), sha256(exportManifestBytes), "portable export manifest changed");
    assert.equal(sha256(await readFile(OUTPUT_SOURCE_MANIFEST_PATH)), sourceManifestSha256, "portable source manifest changed");
    assert.equal(sha256(await readFile(OUTPUT_PROVENANCE_PATH)), sha256(provenanceBytes), "portable provenance changed");
    assert.equal(hashJson(copiedBundleFiles), exported.bundleSha256);
    return {
      status: "current-source-diagnostic-export-complete",
      sourceCommit: inputs.sourceCommit,
      sourceParityReference: inputs.sourceParityReference,
      sourceTreeSha256: exported.sourceTreeSha256,
      sourceFileCount,
      sourceManifestSha256,
      sharedSourceTreeSha256: sourceRoots.find((root) => root.name === "studio-shared")?.sha256,
      dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
      dependencyLockSha256: EXPECTED_DEPENDENCY_LOCK_SHA256,
      bundleSha256: exported.bundleSha256,
      bundleFileCount: exported.bundleFileCount,
      mapFileCount: exportManifest.sourceMapEvidence.mapFileCount,
      officialDistManifestSha256: official.manifestSha256,
      officialBundleSha256: official.bundleSha256,
      comparison,
      packageRoot: OUTPUT_PACKAGE_ROOT,
      bundleRoot: OUTPUT_BUNDLE_ROOT,
      manifestPath: OUTPUT_MANIFEST_PATH,
      provenancePath: OUTPUT_PROVENANCE_PATH,
      exporterPids: {
        dependencyCopier: exported.dependencyCopierPid,
        terminalBuilder: exported.terminalBuilderPid,
        expo: exported.exporterPid,
      },
    };
  });
  console.log(JSON.stringify(result, null, 2));
}

await main();
