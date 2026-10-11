// Independently verify the completed schema-2 export left by a failed wrapper
// and derive browser-consumable schema-1 provenance without rebuilding it.
// This script performs filesystem reads and exclusive copies only. It does not
// start Expo, a Browser, Gateway, Provider, or a user session.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { repoRoot } from "../harness/run-context.mjs";
import { readVerifiedMobileExportFile, verifyMobileExportManifestEnvelope } from "../harness/mobile-web-export-input.mjs";

const EXPECTED_CANDIDATE_DIGEST = "2b9bf9e9e6f623962d04c3561e7130d186d79b91e38fe206cfae79f74154af02";
const EXPECTED_CANDIDATE_COUNT = 315;
const CANDIDATE_ROOT = resolve(repoRoot, "target/private-phone-ux-implementation/worktree-handoff-discovery-static02-20261008-copyable");
const BASE_SOURCE_MANIFEST_PATH = resolve(repoRoot, "target/private-phone-ux-implementation/mobile-web-export-durable-task-handoff-static02-20261008/source-files.json");
const OVERLAY_MANIFEST_PATH = resolve(repoRoot, "target/worktree-handoff-discovery-20261008/static-02/manifest.json");
const OVERLAY_DIFF_PATH = resolve(repoRoot, "target/worktree-handoff-discovery-20261008/static-02/products.diff");
const RUN_ROOT = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/private/mobile-web-export-worktree-handoff-static02-copyable.once.mjs/20261008-153821.956Z");
const RUN_MANIFEST_PATH = resolve(RUN_ROOT, "manifest.json");
const RUN_RESULT_PATH = resolve(RUN_ROOT, "artifacts/result.json");
const EXPORT_MANIFEST_PATH = resolve(RUN_ROOT, "artifacts/mobile-web-export-worktree-handoff-static02-manifest.json");
const SOURCE_BUNDLE_ROOT = resolve(RUN_ROOT, "artifacts/mobile-web-export-worktree-handoff-static02");
const OUTPUT_ROOT = resolve(repoRoot, "target/private-phone-ux-implementation/worktree-handoff-static02-derived-export-153821-20261008");
const OUTPUT_BUNDLE_ROOT = resolve(OUTPUT_ROOT, "bundle");
const OUTPUT_EXPORT_MANIFEST_PATH = resolve(OUTPUT_ROOT, "mobile-web-export-worktree-handoff-static02-schema2-manifest.json");
const OUTPUT_PROVENANCE_PATH = resolve(OUTPUT_ROOT, "mobile-web-export-worktree-handoff-static02-schema1-provenance.json");
const OUTPUT_PROOF_PATH = resolve(OUTPUT_ROOT, "derivation-proof.json");

const EXPECTED_RUN_MANIFEST_SHA256 = "9758756b0e6d3dca3121198cafde8fbdd2d847fed9269a3761b3c31644c3a024";
const EXPECTED_RUN_RESULT_SHA256 = "461e1d4f80331b2c81123a2d0d971cea85f3d134e362a7fe503c0c64c034f992";
const EXPECTED_EXPORT_MANIFEST_SHA256 = "7e18947fd6627cfbfc4770d2e4ee694af87405e03e1a1260f58e32094972b4fe";
const EXPECTED_ORIGINAL_WRAPPER_SHA256 = "0261abcc4e9fc7536eae244b9de137c643747309a481df72181adc55b4adb1d8";
const ORIGINAL_WRAPPER_ARCHIVE = resolve(repoRoot, "target/private-phone-ux-implementation/diagnostics/mobile-web-export-worktree-handoff-static02-copyable-before-schema-name-fix.mjs");

const EXPECTED_FREEZE_SHA256 = "a4c6b30d13638089ecb4b6fa526e197f74e770a46d7dc6d8175690e1de24fee1";
const EXPECTED_SHA_MAP_SHA256 = "c1e69860a445060338aa02f32314cce7963b67dd80aa5b93be892605c032f69c";
const EXPECTED_SOURCE_MANIFEST_SHA256 = "6c760912e1163d5e29fae81ce8f1db34ac7a6a1f08e529d54bad5da5e2a6ff54";
const EXPECTED_CANDIDATE_MANIFEST_SHA256 = "19d067e6f94c9f60b4e83fcd5d6dc1e522cb5108738b801105995df6ba9bc788";
const EXPECTED_METADATA_SHA256 = "44f793fb4e33d487c3dd0e6190d0846a950a563b043584f5e4ebf15d8a795687";
const EXPECTED_OVERLAY_DIFF_SHA256 = "e572050ab7393f6d6787659bb8822c07d03d52ea8f1f99c2f545c7c0ae89296c";
const EXPECTED_BASE_MANIFEST_SHA256 = "4b3b654f3dfe71a277a90422fa50a082ae05fb4947e697c4e5c7f57c3246c780";
const EXPECTED_BASE_SOURCE_DIGEST = "8623b4e873e21303b40ea1f04b7107fd67a54f746ac328515542bf6ffee79892";
const EXPECTED_STATIC02_MANIFEST_SHA256 = "51c36f401fc6addc93610f0c5c690103e4aa397865329e713011dd2e82f2df5e";
const EXPECTED_STATIC02_SOURCE_SHA256 = "a8aa57b0fc3071c01cd0e48276ddc54fb2bd48b189dba492eeb6aa6666574b7a";
const EXPECTED_STATIC02_DIFF_SHA256 = "e572050ab7393f6d6787659bb8822c07d03d52ea8f1f99c2f545c7c0ae89296c";
const EXPECTED_SOURCE_ROOTS = [
  { name: "mobile", destination: "apps/kcoder-studio/mobile", sha256: "d82b6862c489476fa4bbd73ec84838bbf5fe436f1728c606a63ce6e4719fb624", fileCount: 296 },
  { name: "studio-shared", destination: "apps/kcoder-studio/shared", sha256: "5443f5e695e75b82a1365baf90a3c280239bead8855647becfa2c9d67e91fe88", fileCount: 19 },
];
const EXPECTED_DEPENDENCY_SOURCE_SHA256 = "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c";
const EXPECTED_DEPENDENCY_OWNED_SHA256 = "754d1db10bd502faeb0b6e82820d455cae680166008a443f7397457f1ef21d29";
const DEPENDENCY_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/private-phone-ux-implementation/mobile-dependency-input-pinned";
const DEPENDENCY_LOCK_PATH = resolve(DEPENDENCY_ROOT, ".package-lock.json");
const EXPECTED_DEPENDENCY_LOCK_SHA256 = "67c2d1c16857f0ed0f6d2ecb3dcf753f26a268b0f1675c1553018e37e9d231a3";
const NODE_PIN = {
  executable: "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node",
  version: "v22.17.0",
  sha256: "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9",
};
const HELPER_PINS = [
  ["apps/kcoder-studio/e2e/harness/frozen-copy.mjs", "4b7207ca2718bba5cef8923004f6080a9c2d1110166b5909f9dbddf3b8e8ac6e"],
  ["apps/kcoder-studio/e2e/harness/mobile-web-export.mjs", "fbbd2ed8591c8c22cf6c683b024d647610b9df6e568c300ffb1acc13fbbe4b36"],
  ["apps/kcoder-studio/e2e/harness/mobile-web-export-input.mjs", "33d207054f7d8fa41ffa00719d597a566d7f44a32e776ea58395ed8b67171ca0"],
  ["apps/kcoder-studio/e2e/harness/run-context.mjs", "94f0c27306f8944cbd10f1835227a408c51a0b558981d846832bb297c5e5cf11"],
  ["apps/kcoder-studio/e2e/harness/retention.mjs", "9df5193dc1f4bd5565731cf92d0154bb8f3993e8d3c7c3d98f530c8738716532"],
  ["apps/kcoder-studio/e2e/harness/owned-process.mjs", "40a230721ead1ff78877c1b2815aafd220279bccd43d15d78303f30a59cb78af"],
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function sortPath(left, right) {
  return left.path.localeCompare(right.path);
}

async function readRegular(path, label, expectedSha256, { requireReadOnly = false } = {}) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  if (requireReadOnly) assert.equal(info.mode & 0o222, 0, `${label} must be read-only`);
  const bytes = await readFile(path);
  if (expectedSha256) assert.equal(sha256(bytes), expectedSha256, `${label} SHA-256 changed`);
  return { bytes, info };
}

async function assertRealDirectory(path, label, expectedMode) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a real directory`);
  assert.equal(await realpath(path), path, `${label} must have a canonical path`);
  if (expectedMode !== undefined) assert.equal(info.mode & 0o777, expectedMode, `${label} mode changed`);
  return info;
}

async function collectTree(root, { requireReadOnly = false } = {}) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = resolve(directory, child.name);
      const path = relative(root, absolutePath).split(sep).join("/");
      const info = await lstat(absolutePath);
      assert.ok(!info.isSymbolicLink(), `symlink is forbidden in verified tree: ${path}`);
      if (requireReadOnly) assert.equal(info.mode & 0o222, 0, `verified source file or directory is writable: ${path}`);
      if (info.isDirectory()) {
        await visit(absolutePath);
      } else {
        assert.ok(info.isFile(), `special file is forbidden in verified tree: ${path}`);
        const bytes = await readFile(absolutePath);
        entries.push({ path, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(root);
  return entries.sort(sortPath);
}

async function writeExclusive(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonExclusive(path, value) {
  await writeExclusive(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

async function assertAbsent(path, label) {
  await lstat(path).then(() => assert.fail(`${label} must be new and exclusive`), error => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function verifyCandidate() {
  await assertRealDirectory(CANDIDATE_ROOT, "candidate root", 0o555);
  const topEntries = (await readdir(CANDIDATE_ROOT)).sort();
  assert.deepEqual(topEntries, ["candidate-manifest.json", "freeze.json", "metadata.json", "overlay.diff", "sha256.json", "source", "source-files.json"].sort());
  const paths = {
    freeze: resolve(CANDIDATE_ROOT, "freeze.json"),
    shaMap: resolve(CANDIDATE_ROOT, "sha256.json"),
    sourceManifest: resolve(CANDIDATE_ROOT, "source-files.json"),
    candidateManifest: resolve(CANDIDATE_ROOT, "candidate-manifest.json"),
    metadata: resolve(CANDIDATE_ROOT, "metadata.json"),
    overlayDiff: resolve(CANDIDATE_ROOT, "overlay.diff"),
  };
  const [freezeFile, shaMapFile, sourceManifestFile, candidateManifestFile, metadataFile, overlayDiffFile] = await Promise.all([
    readRegular(paths.freeze, "candidate freeze", EXPECTED_FREEZE_SHA256, { requireReadOnly: true }),
    readRegular(paths.shaMap, "candidate SHA map", EXPECTED_SHA_MAP_SHA256, { requireReadOnly: true }),
    readRegular(paths.sourceManifest, "candidate source manifest", EXPECTED_SOURCE_MANIFEST_SHA256, { requireReadOnly: true }),
    readRegular(paths.candidateManifest, "candidate manifest", EXPECTED_CANDIDATE_MANIFEST_SHA256, { requireReadOnly: true }),
    readRegular(paths.metadata, "candidate metadata", EXPECTED_METADATA_SHA256, { requireReadOnly: true }),
    readRegular(paths.overlayDiff, "candidate overlay diff", EXPECTED_OVERLAY_DIFF_SHA256, { requireReadOnly: true }),
  ]);
  const [baseSourceManifestFile, overlayManifestFile, overlayProductsDiffFile] = await Promise.all([
    readRegular(BASE_SOURCE_MANIFEST_PATH, "old declared-315 source manifest", EXPECTED_BASE_MANIFEST_SHA256, { requireReadOnly: true }),
    readRegular(OVERLAY_MANIFEST_PATH, "static-02 overlay manifest", EXPECTED_STATIC02_MANIFEST_SHA256),
    readRegular(OVERLAY_DIFF_PATH, "static-02 overlay products diff", EXPECTED_STATIC02_DIFF_SHA256),
  ]);
  const freeze = JSON.parse(freezeFile.bytes.toString("utf8"));
  const shaMap = JSON.parse(shaMapFile.bytes.toString("utf8"));
  const sourceManifest = JSON.parse(sourceManifestFile.bytes.toString("utf8"));
  const candidateManifest = JSON.parse(candidateManifestFile.bytes.toString("utf8"));
  const metadata = JSON.parse(metadataFile.bytes.toString("utf8"));
  const baseSourceManifest = JSON.parse(baseSourceManifestFile.bytes.toString("utf8"));
  const overlayManifest = JSON.parse(overlayManifestFile.bytes.toString("utf8"));
  assert.equal(freeze.sourceDigest, EXPECTED_CANDIDATE_DIGEST);
  assert.equal(freeze.count, EXPECTED_CANDIDATE_COUNT);
  assert.equal(sourceManifest.status, "FROZEN_SOURCE_INPUTS_NOT_EXPORTED");
  assert.equal(sourceManifest.sourceDigest, EXPECTED_CANDIDATE_DIGEST);
  assert.equal(sourceManifest.count, EXPECTED_CANDIDATE_COUNT);
  assert.equal(candidateManifest.status, "FROZEN_SOURCE_CANDIDATE_NOT_EXPORTED");
  assert.equal(candidateManifest.sourceDigest, EXPECTED_CANDIDATE_DIGEST);
  assert.equal(candidateManifest.fileCount, EXPECTED_CANDIDATE_COUNT);
  assert.equal(metadata.status, "FROZEN_SOURCE_INPUTS_NOT_EXPORTED");
  assert.equal(metadata.sourceDigest, EXPECTED_CANDIDATE_DIGEST);
  assert.equal(metadata.sourceFiles, EXPECTED_CANDIDATE_COUNT);
  assert.equal(metadata.base.declaredManifestSha256, EXPECTED_BASE_MANIFEST_SHA256);
  assert.equal(metadata.base.sourceDigest, EXPECTED_BASE_SOURCE_DIGEST);
  assert.equal(metadata.base.declaredFileCount, EXPECTED_CANDIDATE_COUNT);
  assert.equal(metadata.base.physicalRawFileCount, 316);
  assert.deepEqual(metadata.base.excludedRawFiles, [{
    path: "apps/kcoder-studio/mobile/src/storage/device-secret-binding.test.ts",
    size: 1855,
    sha256: "19f3f7da815c6cf23460f30f37bfa722abc8561e9d5c28c2b4fe6a4a4d2af45b",
  }]);
  assert.equal(metadata.overlay.manifestSha256, EXPECTED_STATIC02_MANIFEST_SHA256);
  assert.equal(metadata.overlay.diffSha256, EXPECTED_STATIC02_DIFF_SHA256);
  assert.equal(metadata.overlay.fileCount, 1);
  assert.equal(baseSourceManifest.status, "FROZEN_SOURCE_INPUTS_NOT_EXPORTED");
  assert.equal(baseSourceManifest.sourceDigest, EXPECTED_BASE_SOURCE_DIGEST);
  assert.equal(baseSourceManifest.count, EXPECTED_CANDIDATE_COUNT);
  assert.equal(baseSourceManifest.files.length, EXPECTED_CANDIDATE_COUNT);
  assert.equal(baseSourceManifest.files.find(file => file.path === "apps/kcoder-studio/mobile/src/app/new.tsx")?.sha256, "dcbc986532e34a0606351166461cf83300357f934d141d2b8f5d9764a15a961b");
  assert.equal(overlayManifest.status, "STATIC_ONLY_NOT_RUN");
  assert.deepEqual(overlayManifest.files, [{
    path: "apps/kcoder-studio/mobile/src/app/new.tsx",
    bytes: 49_013,
    sha256: EXPECTED_STATIC02_SOURCE_SHA256,
  }]);
  assert.equal(sha256(overlayProductsDiffFile.bytes), EXPECTED_STATIC02_DIFF_SHA256);
  assert.deepEqual(metadata.overlay.files, [{
    path: "apps/kcoder-studio/mobile/src/app/new.tsx",
    action: "replace",
    beforeSha256: "dcbc986532e34a0606351166461cf83300357f934d141d2b8f5d9764a15a961b",
    afterSha256: EXPECTED_STATIC02_SOURCE_SHA256,
    size: 49_013,
  }]);
  assert.equal(sha256(overlayDiffFile.bytes), EXPECTED_STATIC02_DIFF_SHA256);
  assert.deepEqual(candidateManifest.roots, EXPECTED_SOURCE_ROOTS);
  assert.deepEqual(sourceManifest.roots, EXPECTED_SOURCE_ROOTS);
  assert.deepEqual(sourceManifest.files, candidateManifest.files);
  assert.equal(candidateManifest.files.length, EXPECTED_CANDIDATE_COUNT);
  assert.equal(Object.keys(shaMap).length, EXPECTED_CANDIDATE_COUNT);
  assert.deepEqual(shaMap, Object.fromEntries(candidateManifest.files.map(file => [`source/${file.path}`, file.sha256])));

  const sourceRoot = resolve(CANDIDATE_ROOT, "source");
  await assertRealDirectory(sourceRoot, "candidate source tree", 0o555);
  const actualRoots = [];
  for (const expectedRoot of EXPECTED_SOURCE_ROOTS) {
    const rootPath = resolve(sourceRoot, expectedRoot.destination);
    await assertRealDirectory(rootPath, `${expectedRoot.name} candidate source`, 0o555);
    const actualEntries = await collectTree(rootPath, { requireReadOnly: true });
    const expectedEntries = candidateManifest.files
      .filter(file => file.path.startsWith(`${expectedRoot.destination}/`))
      .map(file => ({ path: file.path.slice(expectedRoot.destination.length + 1), size: file.size, sha256: file.sha256 }))
      .sort(sortPath);
    assert.deepEqual(actualEntries, expectedEntries, `${expectedRoot.name} actual candidate bytes differ from manifest`);
    assert.equal(actualEntries.length, expectedRoot.fileCount);
    assert.equal(hashJson(actualEntries), expectedRoot.sha256);
    actualRoots.push({ name: expectedRoot.name, destination: expectedRoot.destination, sha256: hashJson(actualEntries) });
  }
  assert.equal(hashJson(actualRoots), EXPECTED_CANDIDATE_DIGEST);
  return {
    paths,
    sourceRoot,
    sourceDigest: EXPECTED_CANDIDATE_DIGEST,
    fileCount: candidateManifest.files.length,
    roots: EXPECTED_SOURCE_ROOTS,
    candidateManifest,
    metadata,
    hashes: {
      baseSourceManifest: EXPECTED_BASE_MANIFEST_SHA256,
      overlayManifest: EXPECTED_STATIC02_MANIFEST_SHA256,
      overlayProductsDiff: EXPECTED_STATIC02_DIFF_SHA256,
      freeze: EXPECTED_FREEZE_SHA256,
      shaMap: EXPECTED_SHA_MAP_SHA256,
      sourceManifest: EXPECTED_SOURCE_MANIFEST_SHA256,
      candidateManifest: EXPECTED_CANDIDATE_MANIFEST_SHA256,
      metadata: EXPECTED_METADATA_SHA256,
      overlayDiff: EXPECTED_OVERLAY_DIFF_SHA256,
    },
  };
}

async function verifyFailedWrapperRun() {
  const [runManifestFile, runResultFile, exportManifestFile, oldWrapperFile] = await Promise.all([
    readRegular(RUN_MANIFEST_PATH, "original RunContext manifest", EXPECTED_RUN_MANIFEST_SHA256),
    readRegular(RUN_RESULT_PATH, "original RunContext result", EXPECTED_RUN_RESULT_SHA256),
    readRegular(EXPORT_MANIFEST_PATH, "completed schema-2 export manifest", EXPECTED_EXPORT_MANIFEST_SHA256),
    readRegular(ORIGINAL_WRAPPER_ARCHIVE, "executed 0261 wrapper archive", EXPECTED_ORIGINAL_WRAPPER_SHA256),
  ]);
  const runManifest = JSON.parse(runManifestFile.bytes.toString("utf8"));
  const runResult = JSON.parse(runResultFile.bytes.toString("utf8"));
  const exportManifest = JSON.parse(exportManifestFile.bytes.toString("utf8"));
  assert.equal(runManifest.status, "failed");
  assert.equal(runResult.status, "failed");
  assert.equal(runManifest.source, "apps/kcoder-studio/e2e/private/mobile-web-export-worktree-handoff-static02-copyable.once.mjs");
  assert.ok(runManifest.error.includes("EEXIST"), "original RunContext must preserve the final metadata collision failure");
  assert.ok(runResult.error.includes("EEXIST"), "original result must preserve the final metadata collision failure");
  assert.ok(runResult.error.includes("mobile-web-export-worktree-handoff-static02-manifest.json"), "original collision must be the schema-1/schema-2 artifact name overlap");
  assert.ok(Array.isArray(runManifest.processes) && runManifest.processes.length > 0);
  assert.ok(runManifest.processes.every(process => process.stopped === true), "all original owned export processes must be terminal");
  assert.equal(sha256(oldWrapperFile.bytes), EXPECTED_ORIGINAL_WRAPPER_SHA256);
  assert.equal(exportManifest.schemaVersion, 2);
  assert.equal(exportManifest.status, "complete");
  assert.equal(exportManifest.failurePhase, null);
  assert.equal(exportManifest.sourceTreeSha256, EXPECTED_CANDIDATE_DIGEST);
  assert.equal(exportManifest.sourceHashBefore, EXPECTED_CANDIDATE_DIGEST);
  assert.equal(exportManifest.sourceHashAfter, EXPECTED_CANDIDATE_DIGEST);
  assert.equal(exportManifest.sourceUnchanged, true);
  assert.equal(exportManifest.buildInputTreeBeforeCopySha256, EXPECTED_CANDIDATE_DIGEST);
  assert.equal(exportManifest.buildInputTreeAfterCopySha256, EXPECTED_CANDIDATE_DIGEST);
  assert.equal(exportManifest.buildInputTreeAfterExportSha256, EXPECTED_CANDIDATE_DIGEST);
  assert.equal(exportManifest.snapshotCopyMatchesSource, true);
  assert.equal(exportManifest.snapshotUnchangedDuringExport, true);
  assert.equal(exportManifest.terminalHookChangesOnlyGeneratedHtml, true);
  assert.deepEqual(exportManifest.inputRoots.map(({ name, destination, sha256: rootSha, fileCount }) => ({ name, destination, sha256: rootSha, fileCount })), EXPECTED_SOURCE_ROOTS);
  assert.deepEqual(exportManifest.inputRootsAfter.map(({ name, destination, sha256: rootSha, fileCount }) => ({ name, destination, sha256: rootSha, fileCount })), EXPECTED_SOURCE_ROOTS);
  const dependency = exportManifest.dependencyProvenance;
  assert.equal(dependency.sourceTreeSha256Before, EXPECTED_DEPENDENCY_SOURCE_SHA256);
  assert.equal(dependency.sourceTreeSha256After, EXPECTED_DEPENDENCY_SOURCE_SHA256);
  assert.equal(dependency.sourceUnchanged, true);
  assert.equal(dependency.copiedTreeSha256, EXPECTED_DEPENDENCY_OWNED_SHA256);
  assert.equal(dependency.copiedFileCount, 52_252);
  assert.equal(dependency.copiedSymlinks, false);
  assert.equal(exportManifest.bundleFileCount, 37);
  verifyMobileExportManifestEnvelope(exportManifest, exportManifestFile.bytes, EXPECTED_EXPORT_MANIFEST_SHA256, "original complete schema-2 export");
  return {
    runManifest,
    runManifestSha256: EXPECTED_RUN_MANIFEST_SHA256,
    runResult,
    runResultSha256: EXPECTED_RUN_RESULT_SHA256,
    exportManifest,
    exportManifestBytes: exportManifestFile.bytes,
    exportManifestSha256: EXPECTED_EXPORT_MANIFEST_SHA256,
    originalWrapperSha256: EXPECTED_ORIGINAL_WRAPPER_SHA256,
  };
}

async function verifyBundle(exportManifest) {
  await assertRealDirectory(SOURCE_BUNDLE_ROOT, "retained original portable bundle");
  const actualFiles = await collectTree(SOURCE_BUNDLE_ROOT);
  const expectedFiles = exportManifest.bundleFiles.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })).sort(sortPath);
  assert.deepEqual(actualFiles, expectedFiles, "retained 37-file bundle differs from the complete schema-2 manifest");
  assert.equal(actualFiles.length, 37);
  assert.equal(hashJson(actualFiles), exportManifest.bundleSha256);
  for (const entry of exportManifest.bundleFiles) await readVerifiedMobileExportFile(SOURCE_BUNDLE_ROOT, entry, "original retained Mobile Web bundle");
  return actualFiles;
}

async function verifyRuntimePins(exportManifest) {
  assert.equal(process.execPath, NODE_PIN.executable);
  assert.equal(process.version, NODE_PIN.version);
  const nodeBytes = await readFile(process.execPath);
  assert.equal(sha256(nodeBytes), NODE_PIN.sha256, "pinned Node binary changed");
  await assertRealDirectory(DEPENDENCY_ROOT, "pinned dependency root", 0o700);
  assert.equal(await realpath(DEPENDENCY_ROOT), DEPENDENCY_ROOT);
  const dependencyLock = await readRegular(DEPENDENCY_LOCK_PATH, "pinned dependency lock", EXPECTED_DEPENDENCY_LOCK_SHA256);
  const helperFiles = [];
  for (const [path, expectedSha256] of HELPER_PINS) {
    const fullPath = resolve(repoRoot, path);
    const { bytes } = await readRegular(fullPath, `pinned export helper ${path}`, expectedSha256);
    helperFiles.push({ path, size: bytes.length, sha256: sha256(bytes) });
  }
  assert.equal(exportManifest.dependencyProvenance.sourceTreeSha256Before, EXPECTED_DEPENDENCY_SOURCE_SHA256);
  assert.equal(exportManifest.dependencyProvenance.copiedTreeSha256, EXPECTED_DEPENDENCY_OWNED_SHA256);
  return {
    node: { ...NODE_PIN },
    dependency: {
      sourceTreeSha256: EXPECTED_DEPENDENCY_SOURCE_SHA256,
      ownedTreeSha256: EXPECTED_DEPENDENCY_OWNED_SHA256,
      copiedFileCount: exportManifest.dependencyProvenance.copiedFileCount,
      lock: {
        path: DEPENDENCY_LOCK_PATH,
        size: dependencyLock.bytes.length,
        sha256: sha256(dependencyLock.bytes),
        observedCurrentMode: `0${(dependencyLock.info.mode & 0o7777).toString(8)}`,
        modeDuringExportGate: "passed in archived wrapper before its final schema-name collision; individual mode values were not persisted by that failed wrapper result",
      },
    },
    helpers: helperFiles,
  };
}

async function copyVerifiedBundle(bundleFiles) {
  await mkdir(OUTPUT_ROOT, { mode: 0o700 });
  await mkdir(OUTPUT_BUNDLE_ROOT, { mode: 0o700 });
  for (const entry of bundleFiles) {
    const bytes = await readVerifiedMobileExportFile(SOURCE_BUNDLE_ROOT, entry, "verified source bundle copy");
    const destination = resolve(OUTPUT_BUNDLE_ROOT, entry.path);
    const relativeDestination = relative(OUTPUT_BUNDLE_ROOT, destination);
    assert.ok(relativeDestination !== ".." && !relativeDestination.startsWith(`..${sep}`), "bundle destination escaped its root");
    await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
    await writeExclusive(destination, bytes);
  }
  const copiedFiles = await collectTree(OUTPUT_BUNDLE_ROOT);
  assert.deepEqual(copiedFiles, bundleFiles, "copied private bundle differs from the verified original bundle");
  return copiedFiles;
}

async function main() {
  await assertRealDirectory(resolve(repoRoot, "target/private-phone-ux-implementation"), "private output parent");
  await assertAbsent(OUTPUT_ROOT, "derived post-export output root");
  const candidate = await verifyCandidate();
  const runEvidence = await verifyFailedWrapperRun();
  const runtimePins = await verifyRuntimePins(runEvidence.exportManifest);
  const bundleFiles = await verifyBundle(runEvidence.exportManifest);

  const copiedBundleFiles = await copyVerifiedBundle(bundleFiles);
  await writeExclusive(OUTPUT_EXPORT_MANIFEST_PATH, runEvidence.exportManifestBytes);
  assert.equal(sha256(await readFile(OUTPUT_EXPORT_MANIFEST_PATH)), runEvidence.exportManifestSha256);

  const sourceRoots = EXPECTED_SOURCE_ROOTS.map(({ name, destination, sha256: rootSha, fileCount }) => ({ name, destination, sha256: rootSha, fileCount }));
  const provenance = {
    schemaVersion: 1,
    status: "complete",
    evidenceKind: "independently-verified-schema1-provenance-derived-from-complete-schema2-export",
    wrapperRun: {
      status: "failed",
      failurePhase: "final reusable schema-1 artifact write collided with the already-written schema-2 exporter manifest",
      runRoot: RUN_ROOT,
      runManifestSha256: runEvidence.runManifestSha256,
      resultSha256: runEvidence.runResultSha256,
      executedWrapperSha256: runEvidence.originalWrapperSha256,
      derivedExportManifestSha256: runEvidence.exportManifestSha256,
      doNotInterpretAsWrapperPass: true,
    },
    sourceTreeSha256: candidate.sourceDigest,
    candidateDigest: candidate.sourceDigest,
    candidateFiles: candidate.fileCount,
    candidateManifestPath: resolve(CANDIDATE_ROOT, "sha256.json"),
    candidateManifestSha256: candidate.hashes.shaMap,
    candidateContentManifestPath: candidate.paths.candidateManifest,
    candidateContentManifestSha256: candidate.hashes.candidateManifest,
    candidateSourceFilesPath: candidate.paths.sourceManifest,
    candidateSourceFilesSha256: candidate.hashes.sourceManifest,
    candidateMobileManifestFiles: 296,
    candidateSharedManifestFiles: 19,
    sourceRoots,
    sourceCompleteness: {
      manifestFileCount: candidate.fileCount,
      workspaceComplementCopied: false,
      candidateMobileManifestFiles: 296,
      candidateSharedManifestFiles: 19,
      sourceRootsIndividuallyPinned: true,
    },
    sourceComplementSha256: null,
    sourceComplementStableDuringCopy: null,
    sourceCommit: "09d1e88342909b36237a571774d2987fa2a8556c",
    sourceFreezeEvidenceKind: "candidate-source-manifest",
    sourceFreezeEvidenceDigest: candidate.sourceDigest,
    baseManifestSha256: EXPECTED_BASE_MANIFEST_SHA256,
    baseSourceDigest: EXPECTED_BASE_SOURCE_DIGEST,
    overlayManifestSha256: EXPECTED_STATIC02_MANIFEST_SHA256,
    overlayDiffSha256: EXPECTED_STATIC02_DIFF_SHA256,
    overlayPath: "apps/kcoder-studio/mobile/src/app/new.tsx",
    overlaySha256: EXPECTED_STATIC02_SOURCE_SHA256,
    sourceTreeVerifiedPerFile: true,
    snapshotCopyMatchesSource: runEvidence.exportManifest.snapshotCopyMatchesSource,
    snapshotUnchangedDuringExport: runEvidence.exportManifest.snapshotUnchangedDuringExport,
    bundleSha256: runEvidence.exportManifest.bundleSha256,
    bundleFileCount: runEvidence.exportManifest.bundleFileCount,
    bundlePath: OUTPUT_BUNDLE_ROOT,
    bundleManifest: OUTPUT_EXPORT_MANIFEST_PATH,
    exportManifestPath: OUTPUT_EXPORT_MANIFEST_PATH,
    exportManifestSha256: runEvidence.exportManifestSha256,
    indexHtmlSha256: runEvidence.exportManifest.indexHtmlSha256,
    dependencySourceTreeSha256: EXPECTED_DEPENDENCY_SOURCE_SHA256,
    dependencyOwnedTreeSha256: EXPECTED_DEPENDENCY_OWNED_SHA256,
    dependencyLock: runtimePins.dependency.lock,
    browserEvidence: "NOT_RUN",
  };
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
  await writeExclusive(OUTPUT_PROVENANCE_PATH, provenanceBytes);

  const derivationProof = {
    schemaVersion: 1,
    status: "verified-derived-inputs",
    createdBy: "derive-worktree-handoff-static02-postexport-schema1.once.mjs",
    sourceRun: {
      runRoot: RUN_ROOT,
      runManifestSha256: runEvidence.runManifestSha256,
      resultSha256: runEvidence.runResultSha256,
      status: "failed",
      failureCategory: "EEXIST while the wrapper attempted a schema-1 reusable-manifest artifact at the schema-2 export-manifest path",
      originalExportManifestPath: EXPORT_MANIFEST_PATH,
      originalExportManifestSha256: runEvidence.exportManifestSha256,
      originalBundleRoot: SOURCE_BUNDLE_ROOT,
      originalWrapperSha256: runEvidence.originalWrapperSha256,
    },
    candidate: {
      root: CANDIDATE_ROOT,
      sourceDigest: candidate.sourceDigest,
      fileCount: candidate.fileCount,
      roots: sourceRoots,
      sha256MapSha256: candidate.hashes.shaMap,
      sourceFilesManifestSha256: candidate.hashes.sourceManifest,
      candidateManifestSha256: candidate.hashes.candidateManifest,
      metadataSha256: candidate.hashes.metadata,
      overlayDiffSha256: candidate.hashes.overlayDiff,
      overlayManifestSha256: EXPECTED_STATIC02_MANIFEST_SHA256,
      overlayNewTsxSha256: EXPECTED_STATIC02_SOURCE_SHA256,
      actualSourceFilesCompared: candidate.fileCount,
    },
    export: {
      builderManifestSchemaVersion: runEvidence.exportManifest.schemaVersion,
      builderManifestStatus: runEvidence.exportManifest.status,
      builderManifestSha256: runEvidence.exportManifestSha256,
      sourceTreeSha256: runEvidence.exportManifest.sourceTreeSha256,
      bundleSha256: runEvidence.exportManifest.bundleSha256,
      bundleFileCount: runEvidence.exportManifest.bundleFileCount,
      indexHtmlSha256: runEvidence.exportManifest.indexHtmlSha256,
      actualSourceBundlePath: SOURCE_BUNDLE_ROOT,
      actualBundleFilesVerified: bundleFiles.length,
      copiedBundlePath: OUTPUT_BUNDLE_ROOT,
      copiedBundleFilesVerified: copiedBundleFiles.length,
      copiedFiles: copiedBundleFiles,
      schema2ManifestByteIdenticalCopyPath: OUTPUT_EXPORT_MANIFEST_PATH,
      schema2ManifestCopiedSha256: sha256(await readFile(OUTPUT_EXPORT_MANIFEST_PATH)),
      sourceUnchanged: runEvidence.exportManifest.sourceUnchanged,
      snapshotCopyMatchesSource: runEvidence.exportManifest.snapshotCopyMatchesSource,
      snapshotUnchangedDuringExport: runEvidence.exportManifest.snapshotUnchangedDuringExport,
    },
    runtimePins,
    derivedProvenancePath: OUTPUT_PROVENANCE_PATH,
    derivedProvenanceSha256: sha256(provenanceBytes),
    boundary: "This records an independently verified complete export artifact and private copy. The original RunContext result remains failed; this is not a wrapper PASS and no Browser test was run.",
  };
  await writeJsonExclusive(OUTPUT_PROOF_PATH, derivationProof);

  const outputSummary = {
    status: "derived-inputs-verified",
    originalWrapperRunStatus: "failed",
    originalRunRoot: RUN_ROOT,
    candidateSourceDigest: candidate.sourceDigest,
    candidateFilesVerified: candidate.fileCount,
    exportManifestSha256: runEvidence.exportManifestSha256,
    bundleSha256: runEvidence.exportManifest.bundleSha256,
    bundleFilesVerified: copiedBundleFiles.length,
    provenancePath: OUTPUT_PROVENANCE_PATH,
    provenanceSha256: sha256(provenanceBytes),
    proofPath: OUTPUT_PROOF_PATH,
  };
  console.log(JSON.stringify(outputSummary));
}

await main();
