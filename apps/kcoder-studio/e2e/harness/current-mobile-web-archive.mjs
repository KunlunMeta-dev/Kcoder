import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { repoRoot as defaultRepoRoot } from "./run-context.mjs";
import { inspectOfficialMobileStaticDist } from "./mobile-static-dist-input.mjs";
import { validatePinnedGatewayRuntime } from "./pinned-gateway.mjs";

export const CURRENT_ARCHIVED_BUNDLE_EVIDENCE = "CURRENT_ARCHIVED_BUNDLE_FUNCTIONAL";
export const CURRENT_ARCHIVE_FLAG = "--current-archive";

const archiveRelativeRoot = "target/private-new-add-project-navigation-20261009/export-archive-01";
const archivePins = Object.freeze({
  promotionSha256: "b6e4491d8b4b4620054c15948dd28c0d5bfb33193097375e7b67b999eb00173b",
  receiptSha256: "63b52aed43fe8a4c5df22db326b7b08d7dd71cb11e3d3a6eefa01852e5eee433",
  runManifestSha256: "2c3617888ac6e8489e24d0e9adebc6b5181eafa7bf13f8b7c9608fdcfa1b79ea",
  resultSha256: "8d3d75783b8e4b33f2ead865f3be3be6db749fe9e8732514e1b125a8bb9569ab",
  exporterManifestSha256: "3b5a31f38eb339d120dd09b9415d10bb5b0dab0d965613e8f18813a19b992c24",
  sourcePinsSha256: "23c237a2265f728749a11bf0310b8b8ed2968ba83963ee579b4bdf5279cc4739",
  officialManifestSha256: "c21b711f8aca4b1a99a1c19a7c830794974ea029e35c05d94b27d9446cc1bc0a",
  sourceTreeSha256: "91844534e10b4d01a15cbb2c20b02bf9047db5fc8fd251310e3e19d4f5bbc09a",
  mobileSourceTreeSha256: "e21e6c08d656921d378d1c6c48dd4274e23ab1e0ce31876e1666a1469e416c42",
  sharedSourceTreeSha256: "5443f5e695e75b82a1365baf90a3c280239bead8855647becfa2c9d67e91fe88",
  bundleSha256: "11f0ac83924dcb15a99a5c7df3930b58fdff9682171f37ae5e53e2eaa2262853",
  resourceTableSha256: "3cd69c6474566bd9c56ab3eafe777bc7effb8303da1515fb96b723782b7b1785",
  dependencySourceTreeSha256: "98b20ed466adf6754fb60876643485eb2748963ef665563006d933978c53c83b",
  copiedDependencyTreeSha256: "8d802eb1eb08d5c2147982319e46e7f16e5382173de170789e25b8d2be51d485",
  runSource: "apps/kcoder-studio/e2e/private/mobile-new-add-project-held-catalog.once.e2e.mjs",
  runTestId: "mobile-new-add-project-held-catalog-export",
  archivedManifestName: "mobile-web-export-new-add-project-current-manifest.json",
  sourceBeforeName: "source-before.json",
  sourceAfterName: "source-after.json",
});

const productPins = Object.freeze({
  "apps/kcoder-studio/mobile/src/app/new.tsx": "ddd8c358c783412a9f13f77604fd99e28aa53b4f5860c0e30fc4c7fc0da0ddeb",
  "apps/kcoder-studio/mobile/src/app/__tests__/new-catalog-read-publication.review.test.tsx": "4ce3918d1716a733d61a85347a3a3cb2cbec480e0a0fa5e361cf543e3aba0eaa",
  "apps/kcoder-studio/mobile/src/runtime/task-runtime/workspaces.ts": "66b0be06affc3396145078ef7473bcd7ff7893dd82a206e703e535d24f5f16a5",
  "apps/kcoder-studio/mobile/src/app/open-project.tsx": "21c4d8e87ebd7ffffc2446c145335ae10581aa6f6494af73954c9d404bb54298",
  "apps/kcoder-studio/mobile/src/runtime/task-runtime.catalog-snapshot-v1.review.test.ts": "9de3036a563755f9f12ce5d5b97dc1c121eb96a125424e238e5e60ba80926c80",
});

const CURRENT_GATEWAY_PINS = Object.freeze({
  snapshotRelativePath: "target/private-phone-ux-implementation/shared-gateway-current-20261009/snapshot-20261009-223221.326Z",
  expectedManifestSha256: "0219dce48d65e6413ce60d0aadfe1fe8047426c6570689ecaf77d757f256cda5",
  expectedSourceTreeSha256: "6a8255fa538d6f2534d1784a088de9757283e8935e69a0d78a95358bb49ae197",
  expectedDependencyTreeSha256: "e4c3f6c05ae21d89fe452794dd4c507c72b4fdac6646aa8eab19874275336954",
  expectedDevServerSha256: "0b70b5262eba51c5018750411116b416d92355506637553e48f6e1b29fb4b161",
  expectedBinaryPath: "target/private-b6-device-revoke-20261009/build-03/owned-kcoder-copy",
  expectedBinarySha256: "bc985854134edffc02415a5d9e72f8905fdc23e7e2263e84f9554e53619dec29",
  expectedNodeVersion: "v22.17.0",
  expectedNodeSha256: "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9",
});

const maximumJsonBytes = 2 * 1024 * 1024;
const maximumRunBytes = 16 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;

/** An explicit, value-free selector; default callers keep their historical branch. */
export function currentArchivedBundleRequested(argv = process.argv) {
  const selected = argv.filter(value => value === CURRENT_ARCHIVE_FLAG).length;
  assert.ok(selected <= 1, `${CURRENT_ARCHIVE_FLAG} may only appear once`);
  assert.ok(!argv.some(value => typeof value === "string" && value.startsWith(`${CURRENT_ARCHIVE_FLAG}=`)),
    `${CURRENT_ARCHIVE_FLAG} does not accept a path or value`);
  return selected === 1;
}

/**
 * Verify the preserved held-catalog export using its own archive schema. This
 * intentionally does not manufacture the historical official-export receipt or
 * assert complete current-Git source provenance.
 */
export async function inspectCurrentArchivedMobileWeb({ repoRoot = defaultRepoRoot } = {}) {
  assert.ok(isAbsolute(repoRoot) && resolve(repoRoot) === repoRoot, "repository root must be a normalized absolute path");
  const archiveRoot = resolve(repoRoot, archiveRelativeRoot);
  await assertRealDirectory(archiveRoot);

  const promotion = await readPinnedJson(archiveRoot, "promotion.json", archivePins.promotionSha256);
  assert.equal(promotion.status, "PASS_EXPORT_ARCHIVED_NOT_BROWSER");
  assert.equal(promotion.receiptSha256, archivePins.receiptSha256);
  assert.equal(promotion.officialManifestSha256, archivePins.officialManifestSha256);
  assert.equal(promotion.bundleSha256, archivePins.bundleSha256);
  assert.equal(promotion.sourceTreeSha256, archivePins.sourceTreeSha256);
  assert.equal(promotion.resourceCount, 37);
  assert.equal(promotion.physicalFileCount, 38);
  assert.equal(promotion.treeEntryCount, 56);
  const runRoot = join(archiveRoot, "run");
  assert.equal(promotion.archiveRun, runRoot, "archive promotion run path changed");
  assert.equal(promotion.receiptPath, join(runRoot, "artifacts/export-receipt.json"), "archive receipt path changed");
  await verifyPromotedRunTree(runRoot, promotion.files);

  const runManifest = await readPinnedJson(runRoot, "manifest.json", archivePins.runManifestSha256);
  assert.equal(runManifest.status, "passed");
  assert.equal(runManifest.error, null);
  assert.equal(runManifest.source, archivePins.runSource);
  assert.equal(runManifest.testId, archivePins.runTestId);
  assert.equal(runManifest.tier, "manual-live");
  assert.deepEqual(runManifest.ports, []);
  assert.ok(Array.isArray(runManifest.processes) && runManifest.processes.length === 3);
  assert.ok(runManifest.processes.every(row => row.stopped === true && row.spawnError === null));
  assert.ok(Array.isArray(runManifest.cleanupSteps) && runManifest.cleanupSteps.length === 3);
  assert.ok(runManifest.cleanupSteps.every(row => row.status === "completed"));

  const result = await readPinnedJson(runRoot, "artifacts/result.json", archivePins.resultSha256);
  assert.equal(result.status, "passed");
  assert.equal(result.testId, runManifest.testId);
  assert.deepEqual(result.cleanupErrors, []);

  const receipt = await readPinnedJson(runRoot, "artifacts/export-receipt.json", archivePins.receiptSha256);
  assert.equal(receipt.status, "PASS_EXPORT_NOT_BROWSER");
  assert.equal(receipt.bundleDirectory, "mobile-web-bundle");
  assert.equal(receipt.sourceTreeSha256, archivePins.sourceTreeSha256);
  assert.equal(receipt.bundleSha256, archivePins.bundleSha256);
  assert.equal(receipt.exporterManifestSha256, archivePins.exporterManifestSha256);
  assert.equal(receipt.officialManifestSha256, archivePins.officialManifestSha256);
  assert.equal(receipt.officialResourceCount, 37);
  assert.equal(receipt.officialResourceTableSha256, archivePins.resourceTableSha256);
  assert.deepEqual(receipt.productPins, productPins);

  const exporterManifest = await readPinnedJson(runRoot,
    `artifacts/${archivePins.archivedManifestName}`, archivePins.exporterManifestSha256);
  validateExporterManifest(exporterManifest);
  const sourceBefore = await readPinnedJson(runRoot, `artifacts/${archivePins.sourceBeforeName}`, archivePins.sourcePinsSha256);
  const sourceAfter = await readPinnedJson(runRoot, `artifacts/${archivePins.sourceAfterName}`, archivePins.sourcePinsSha256);
  assert.deepEqual(sourceBefore, sourceAfter, "the archived source pin table changed during export");
  assert.deepEqual(receipt.sourceBefore, sourceBefore, "the receipt source pin table differs from the archived copy");
  assert.deepEqual(pickProductPins(sourceBefore), productPins, "archived five-file product pins changed");
  assert.deepEqual(receipt.bundleFiles, exporterManifest.bundleFiles, "receipt and exporter bundle inventories differ");

  const distRoot = resolve(runRoot, "artifacts", receipt.bundleDirectory);
  const staticDist = await inspectOfficialMobileStaticDist({
    distRoot,
    expectedManifestSha256: archivePins.officialManifestSha256,
  });
  assert.equal(await countTreeEntries(distRoot), promotion.treeEntryCount,
    "promoted public static bundle tree entry count changed");
  assert.equal(staticDist.resourceCount, 37);
  assert.equal(staticDist.resourceTableSha256, archivePins.resourceTableSha256);
  const manifestRows = staticDist.resources.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  const sortedExporterRows = [...exporterManifest.bundleFiles].sort((left, right) => compareText(left.path, right.path));
  assert.deepEqual(manifestRows, sortedExporterRows, "official static resources differ from the frozen exporter table");

  const sourceRoots = exporterManifest.inputRoots.map(row => ({
    name: row.name,
    destination: row.destination,
    sourceTreeSha256: row.sha256,
    fileCount: row.fileCount,
  }));
  return {
    evidenceClass: CURRENT_ARCHIVED_BUNDLE_EVIDENCE,
    sourceClaim: "archived exporter aggregate plus its five recorded product pins; not full current Git source provenance",
    archiveRelativeRoot,
    exportRunTestId: runManifest.testId,
    receiptSha256: archivePins.receiptSha256,
    promotionSha256: archivePins.promotionSha256,
    exporterManifestSha256: archivePins.exporterManifestSha256,
    sourceBeforeAfterSha256: archivePins.sourcePinsSha256,
    officialManifestSha256: staticDist.manifestSha256,
    sourceTreeSha256: exporterManifest.sourceTreeSha256,
    sourceRoots,
    productPins: { ...productPins },
    bundleSha256: exporterManifest.bundleSha256,
    resourceCount: staticDist.resourceCount,
    resourceTableSha256: staticDist.resourceTableSha256,
    distRoot,
    manifestPath: staticDist.manifestPath,
    bundleFiles: exporterManifest.bundleFiles,
    archivedBuilderCommit: runManifest.gitCommit,
    builderCommitIsNotCurrentSourceClaim: true,
    dependencies: {
      sourceTreeSha256Before: exporterManifest.dependencyProvenance.sourceTreeSha256Before,
      sourceTreeSha256After: exporterManifest.dependencyProvenance.sourceTreeSha256After,
      copiedTreeSha256: exporterManifest.dependencyProvenance.copiedTreeSha256,
      copiedFileCount: exporterManifest.dependencyProvenance.copiedFileCount,
      sourceUnchanged: exporterManifest.dependencyProvenance.sourceUnchanged,
      copiedSymlinks: exporterManifest.dependencyProvenance.copiedSymlinks,
    },
    exportStatus: "passed with completed cleanup; export evidence only, not Browser evidence",
  };
}

export async function validateCurrentArchivedGateway() {
  assert.equal(process.version, CURRENT_GATEWAY_PINS.expectedNodeVersion, "Node version differs from the frozen Gateway runtime");
  const runtime = await validatePinnedGatewayRuntime(CURRENT_GATEWAY_PINS);
  assert.equal(await hashFile(runtime.nodeExecutable), CURRENT_GATEWAY_PINS.expectedNodeSha256, "frozen Node executable changed");
  return runtime;
}

export function currentArchivedGatewayPins() {
  return { ...CURRENT_GATEWAY_PINS };
}

function validateExporterManifest(manifest) {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.failurePhase, null);
  assert.equal(manifest.sourceTreeSha256, archivePins.sourceTreeSha256);
  assert.equal(manifest.sourceHashBefore, archivePins.sourceTreeSha256);
  assert.equal(manifest.sourceHashAfter, archivePins.sourceTreeSha256);
  assert.equal(manifest.sourceUnchanged, true);
  assert.equal(manifest.snapshotCopyMatchesSource, true);
  assert.equal(manifest.snapshotUnchangedDuringExport, true);
  assert.equal(manifest.terminalHookChangesOnlyGeneratedHtml, true);
  assert.equal(manifest.deployMount, true);
  assert.deepEqual(manifest.sourceHashExclusions, [".expo", ".git", "dist", "dotenv and credential files", "node_modules"]);
  assert.deepEqual(manifest.inputRoots.map(row => [row.name, row.destination, row.sha256, row.fileCount]), [
    ["mobile", "apps/kcoder-studio/mobile", archivePins.mobileSourceTreeSha256, 352],
    ["studio-shared", "apps/kcoder-studio/shared", archivePins.sharedSourceTreeSha256, 19],
  ]);
  assert.deepEqual(manifest.inputRootsAfter, manifest.inputRoots);
  assert.equal(manifest.dependencyProvenance.sourceTreeSha256Before, archivePins.dependencySourceTreeSha256);
  assert.equal(manifest.dependencyProvenance.sourceTreeSha256After, archivePins.dependencySourceTreeSha256);
  assert.equal(manifest.dependencyProvenance.sourceUnchanged, true);
  assert.equal(manifest.dependencyProvenance.copiedTreeSha256, archivePins.copiedDependencyTreeSha256);
  assert.equal(manifest.dependencyProvenance.copiedFileCount, 52_524);
  assert.equal(manifest.dependencyProvenance.copiedSymlinks, false);
  assert.equal(manifest.bundleSha256, archivePins.bundleSha256);
  assert.equal(manifest.bundleFileCount, 37);
  assert.ok(Array.isArray(manifest.bundleFiles) && manifest.bundleFiles.length === 37);
  assert.deepEqual(manifest.bundleFiles.map(({ path, size, sha256 }) => ({ path, size, sha256 })), manifest.bundleFiles);
  assert.equal(new Set(manifest.bundleFiles.map(row => row.path)).size, 37);
  assert.equal(sha256(Buffer.from(JSON.stringify(manifest.bundleFiles))), archivePins.bundleSha256);
}

async function verifyPromotedRunTree(runRoot, rows) {
  await assertRealDirectory(runRoot);
  assert.ok(Array.isArray(rows) && rows.length === 47, "promotion file inventory changed");
  const expectedFiles = [];
  let totalBytes = 0;
  for (const row of rows) {
    assert.ok(row && typeof row === "object" && !Array.isArray(row));
    const pathParts = safeRelativePath(row.path);
    assert.ok(row.path === "manifest.json" || row.path.startsWith("artifacts/") || row.path.startsWith("logs/"),
      "promotion file is outside its owned RunContext areas");
    assert.ok(Number.isSafeInteger(row.size) && row.size >= 0);
    assert.match(row.sha256, digestPattern);
    totalBytes += row.size;
    assert.ok(totalBytes <= maximumRunBytes, "promoted RunContext exceeds the bounded verification size");
    const filePath = resolve(runRoot, ...pathParts);
    assertContained(runRoot, filePath);
    const bytes = await readBoundedFile(runRoot, row.path, row.size);
    assert.equal(sha256(bytes), row.sha256, `promoted archive file changed: ${row.path}`);
    expectedFiles.push({ path: row.path, size: row.size, sha256: row.sha256 });
  }
  expectedFiles.sort((a, b) => compareText(a.path, b.path));
  assert.equal(new Set(expectedFiles.map(row => row.path)).size, rows.length, "promotion file inventory has duplicates");
  const actual = await scanRunTree(runRoot);
  assert.deepEqual(actual.files, expectedFiles, "promoted archive RunContext file set differs from its receipt");
}

async function scanRunTree(root) {
  const files = [];
  let entryCount = 0;
  const walk = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeRelativePath(path);
      const absolutePath = join(directory, entry.name);
      const info = await lstat(absolutePath);
      entryCount += 1;
      assert.equal(info.isSymbolicLink(), false, `promoted RunContext contains a symlink: ${path}`);
      if (info.isDirectory()) await walk(absolutePath, path);
      else if (info.isFile()) {
        const bytes = await readBoundedFile(root, path, info.size);
        files.push({ path, size: bytes.length, sha256: sha256(bytes) });
      } else assert.fail(`promoted RunContext contains a special file: ${path}`);
    }
  };
  await walk(root);
  files.sort((a, b) => compareText(a.path, b.path));
  return { files, entryCount };
}

async function countTreeEntries(root) {
  let count = 0;
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      assert.equal(info.isSymbolicLink(), false, "promoted public static bundle contains a symlink");
      count += 1;
      if (info.isDirectory()) await walk(path);
      else assert.ok(info.isFile(), "promoted public static bundle contains a special file");
    }
  };
  await walk(root);
  return count;
}

async function readPinnedJson(root, relativePath, expectedSha256) {
  const bytes = await readBoundedFile(root, relativePath, maximumJsonBytes);
  assert.equal(sha256(bytes), expectedSha256, `archived evidence SHA changed: ${relativePath}`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    assert.fail(`archived evidence is not valid JSON: ${relativePath}`);
  }
}

async function readBoundedFile(root, relativePath, maxBytes) {
  const pathParts = safeRelativePath(relativePath);
  const absolutePath = resolve(root, ...pathParts);
  assertContained(root, absolutePath);
  let current = root;
  for (const part of pathParts) {
    current = join(current, part);
    const info = await lstat(current);
    assert.equal(info.isSymbolicLink(), false, `archived evidence contains a symlink: ${relative(root, current)}`);
    if (current !== absolutePath) assert.ok(info.isDirectory(), `archived evidence parent is not a directory: ${relative(root, current)}`);
    else assert.ok(info.isFile(), `archived evidence is not a regular file: ${relative(root, current)}`);
  }
  const before = await lstat(absolutePath);
  assert.ok(before.size <= maxBytes, `archived evidence exceeds its size bound: ${relative(root, absolutePath)}`);
  assert.equal(await realpath(absolutePath), absolutePath, "archived evidence path traverses a symlink");
  const bytes = await readFile(absolutePath);
  const after = await lstat(absolutePath);
  assert.deepEqual(
    { dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs },
    { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs },
    `archived evidence changed while reading: ${relative(root, absolutePath)}`,
  );
  assert.ok(bytes.length <= maxBytes && bytes.length === before.size,
    `archived evidence size changed while reading: ${relative(root, absolutePath)}`);
  return bytes;
}

async function assertRealDirectory(path) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `archive path must be a real directory: ${path}`);
  assert.equal(await realpath(path), path, "archive path must not traverse a symlink");
}

function safeRelativePath(value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 1024, "archived path is invalid");
  assert.ok(!value.includes("\\") && !value.includes("\0") && !isAbsolute(value), "archived path must be relative POSIX path");
  const parts = value.split("/");
  assert.ok(parts.every(part => part && part !== "." && part !== ".."), "archived path has an unsafe segment");
  return parts;
}

function pickProductPins(sourceRows) {
  return Object.fromEntries(Object.keys(productPins).map(path => [path, sourceRows[path]]));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "pinned runtime executable must be a regular file");
  return sha256(await readFile(path));
}

function assertContained(root, path) {
  const pathRelative = relative(root, path);
  assert.ok(pathRelative && pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative),
    "archived path escaped its root");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
