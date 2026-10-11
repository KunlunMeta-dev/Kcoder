// One-off static Mobile Web export for the reviewed worktree-handoff New.tsx
// candidate. This is model-independent build preparation only; no Gateway,
// Browser, Provider, or user session is started by this exporter.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { copyFrozenMobileWeb, copyVerifiedSnapshot } from "../harness/frozen-copy.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const TEST_ID = "mobile-web-export-worktree-handoff-static02-copyable";
const CANDIDATE_ROOT = resolve(
  repoRoot,
  "target/private-phone-ux-implementation/worktree-handoff-discovery-static02-20261008-copyable",
);
const EXPECTED_CANDIDATE_DIGEST = "2b9bf9e9e6f623962d04c3561e7130d186d79b91e38fe206cfae79f74154af02";
const EXPECTED_CANDIDATE_COUNT = 315;
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
const EXPECTED_DEPENDENCY_SOURCE_SHA256 = "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c";
const EXPECTED_DEPENDENCY_LOCK_SHA256 = "67c2d1c16857f0ed0f6d2ecb3dcf753f26a268b0f1675c1553018e37e9d231a3";
const EXPECTED_DEPENDENCY_OWNED_SHA256 = "754d1db10bd502faeb0b6e82820d455cae680166008a443f7397457f1ef21d29";
const DEPENDENCY_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/private-phone-ux-implementation/mobile-dependency-input-pinned";
const DEPENDENCY_LOCK_RELATIVE_PATH = ".package-lock.json";
const DEPENDENCY_LOCK_PATH = resolve(DEPENDENCY_ROOT, DEPENDENCY_LOCK_RELATIVE_PATH);
const NODE_PIN = {
  executable: "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node",
  version: "v22.17.0",
  sha256: "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9",
};
const EXPORT_HELPER_PINS = new Map([
  ["apps/kcoder-studio/e2e/harness/frozen-copy.mjs", "4b7207ca2718bba5cef8923004f6080a9c2d1110166b5909f9dbddf3b8e8ac6e"],
  ["apps/kcoder-studio/e2e/harness/mobile-web-export.mjs", "fbbd2ed8591c8c22cf6c683b024d647610b9df6e568c300ffb1acc13fbbe4b36"],
  ["apps/kcoder-studio/e2e/harness/run-context.mjs", "94f0c27306f8944cbd10f1835227a408c51a0b558981d846832bb297c5e5cf11"],
  ["apps/kcoder-studio/e2e/harness/retention.mjs", "9df5193dc1f4bd5565731cf92d0154bb8f3993e8d3c7c3d98f530c8738716532"],
  ["apps/kcoder-studio/e2e/harness/owned-process.mjs", "40a230721ead1ff78877c1b2815aafd220279bccd43d15d78303f30a59cb78af"],
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readPinnedRegular(path, expectedSha256, label, { readOnly = false } = {}) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  if (readOnly) assert.equal(info.mode & 0o222, 0, `${label} must remain read-only`);
  const bytes = await readFile(path);
  assert.equal(sha256(bytes), expectedSha256, `${label} digest changed`);
  return bytes;
}

async function readPinnedRegularWithStableMode(path, expectedSha256, label) {
  const before = await lstat(path);
  assert.ok(before.isFile() && !before.isSymbolicLink(), `${label} must be a regular file`);
  const modeBefore = before.mode & 0o7777;
  const bytes = await readPinnedRegular(path, expectedSha256, label);
  const after = await lstat(path);
  assert.ok(after.isFile() && !after.isSymbolicLink(), `${label} must remain a regular file`);
  const modeAfter = after.mode & 0o7777;
  assert.equal(modeAfter, modeBefore, `${label} mode changed while being read`);
  return {
    bytes,
    modeBefore: `0${modeBefore.toString(8)}`,
    modeAfter: `0${modeAfter.toString(8)}`,
  };
}

async function assertDirectory(path, expectedMode, label) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a real directory`);
  assert.equal(await realpath(path), path, `${label} must not traverse a symlink`);
  if (expectedMode !== undefined) assert.equal(info.mode & 0o777, expectedMode, `${label} permissions changed`);
  if (typeof process.getuid === "function") assert.equal(info.uid, process.getuid(), `${label} owner changed`);
  return info;
}

async function collectRoot(root, destination) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = resolve(directory, child.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      const info = await lstat(absolutePath);
      assert.ok(!info.isSymbolicLink(), `candidate source contains a symlink: ${relativePath}`);
      assert.equal(info.mode & 0o222, 0, `candidate source is writable: ${relativePath}`);
      if (info.isDirectory()) {
        await visit(absolutePath);
      } else if (info.isFile()) {
        const bytes = await readFile(absolutePath);
        entries.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
      } else {
        assert.fail(`candidate source contains a special file: ${relativePath}`);
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    name: destination === "apps/kcoder-studio/mobile" ? "mobile" : "studio-shared",
    destination,
    entries,
    sha256: hashJson(entries),
    fileCount: entries.length,
  };
}

function aggregateSourceDigest(roots) {
  return hashJson(roots.map(({ name, destination, sha256: rootSha256 }) => ({
    name,
    destination,
    sha256: rootSha256,
  })));
}

async function verifyCandidate() {
  await assertDirectory(CANDIDATE_ROOT, 0o555, "static-02 candidate root");
  const sourceRoot = resolve(CANDIDATE_ROOT, "source");
  await assertDirectory(sourceRoot, 0o555, "static-02 candidate source tree");
  const [freezeBytes, shaMapBytes, sourceManifestBytes, candidateManifestBytes, metadataBytes, diffBytes] = await Promise.all([
    readPinnedRegular(resolve(CANDIDATE_ROOT, "freeze.json"), EXPECTED_FREEZE_SHA256, "candidate freeze", { readOnly: true }),
    readPinnedRegular(resolve(CANDIDATE_ROOT, "sha256.json"), EXPECTED_SHA_MAP_SHA256, "candidate SHA map", { readOnly: true }),
    readPinnedRegular(resolve(CANDIDATE_ROOT, "source-files.json"), EXPECTED_SOURCE_MANIFEST_SHA256, "candidate source manifest", { readOnly: true }),
    readPinnedRegular(resolve(CANDIDATE_ROOT, "candidate-manifest.json"), EXPECTED_CANDIDATE_MANIFEST_SHA256, "candidate manifest", { readOnly: true }),
    readPinnedRegular(resolve(CANDIDATE_ROOT, "metadata.json"), EXPECTED_METADATA_SHA256, "candidate metadata", { readOnly: true }),
    readPinnedRegular(resolve(CANDIDATE_ROOT, "overlay.diff"), EXPECTED_OVERLAY_DIFF_SHA256, "candidate overlay diff", { readOnly: true }),
  ]);
  const freeze = JSON.parse(freezeBytes.toString("utf8"));
  const shaMap = JSON.parse(shaMapBytes.toString("utf8"));
  const sourceManifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  const candidateManifest = JSON.parse(candidateManifestBytes.toString("utf8"));
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
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
  assert.equal(metadata.base.sourceDigest, EXPECTED_BASE_SOURCE_DIGEST);
  assert.equal(metadata.base.declaredManifestSha256, EXPECTED_BASE_MANIFEST_SHA256);
  assert.equal(metadata.base.declaredFileCount, EXPECTED_CANDIDATE_COUNT);
  assert.equal(metadata.base.physicalRawFileCount, 316);
  assert.equal(metadata.base.excludedRawFiles.length, 1);
  assert.equal(metadata.base.excludedRawFiles[0].path, "apps/kcoder-studio/mobile/src/storage/device-secret-binding.test.ts");
  assert.equal(metadata.overlay.manifestSha256, EXPECTED_STATIC02_MANIFEST_SHA256);
  assert.equal(metadata.overlay.diffSha256, EXPECTED_STATIC02_DIFF_SHA256);
  assert.equal(metadata.overlay.fileCount, 1);
  assert.deepEqual(metadata.overlay.files, [{
    path: "apps/kcoder-studio/mobile/src/app/new.tsx",
    action: "replace",
    beforeSha256: "dcbc986532e34a0606351166461cf83300357f934d141d2b8f5d9764a15a961b",
    afterSha256: EXPECTED_STATIC02_SOURCE_SHA256,
    size: 49_013,
  }]);

  const candidateEntries = candidateManifest.files;
  assert.equal(candidateEntries.length, EXPECTED_CANDIDATE_COUNT);
  assert.equal(sourceManifest.files.length, EXPECTED_CANDIDATE_COUNT);
  assert.equal(Object.keys(shaMap).length, EXPECTED_CANDIDATE_COUNT);
  assert.deepEqual(candidateEntries, sourceManifest.files, "candidate and source manifests differ");
  const expectedCopyMap = Object.fromEntries(candidateEntries.map(({ path, sha256: fileSha }) => [`source/${path}`, fileSha]));
  assert.deepEqual(shaMap, expectedCopyMap, "copy-helper source/ path map differs from declared candidate");
  const roots = [];
  for (const root of candidateManifest.roots) {
    const absoluteRoot = resolve(sourceRoot, root.destination);
    await assertDirectory(absoluteRoot, 0o555, `${root.name} candidate source root`);
    const actual = await collectRoot(absoluteRoot, root.destination);
    assert.equal(actual.fileCount, root.fileCount, `${root.name} candidate file count changed`);
    assert.equal(actual.sha256, root.sha256, `${root.name} candidate source tree changed`);
    for (const entry of actual.entries) {
      const fullPath = `${root.destination}/${entry.path}`;
      const expected = candidateEntries.find(candidate => candidate.path === fullPath);
      assert.ok(expected, `candidate source has an undeclared file: ${fullPath}`);
      assert.deepEqual(entry, { path: expected.path.slice(root.destination.length + 1), size: expected.size, sha256: expected.sha256 });
    }
    roots.push({ name: root.name, destination: root.destination, sha256: actual.sha256 });
  }
  assert.equal(roots.reduce((sum, root) => sum + candidateManifest.roots.find(item => item.name === root.name).fileCount, 0), EXPECTED_CANDIDATE_COUNT);
  const actualSourceDigest = aggregateSourceDigest(roots);
  assert.equal(actualSourceDigest, EXPECTED_CANDIDATE_DIGEST, "candidate source aggregate changed");
  const expectedMapPaths = candidateEntries.map(({ path }) => `source/${path}`).sort(codepointCompare);
  const actualMapPaths = Object.keys(shaMap).sort(codepointCompare);
  assert.deepEqual(actualMapPaths, expectedMapPaths, "candidate SHA map path set changed");
  return { sourceRoot, sourceDigest: actualSourceDigest, fileCount: candidateEntries.length, metadata };
}

async function verifyRuntimePins() {
  assert.equal(process.execPath, NODE_PIN.executable, "export must use the pinned Node binary");
  assert.equal(process.version, NODE_PIN.version, "export must use the pinned Node version");
  assert.equal(sha256(await readFile(process.execPath)), NODE_PIN.sha256, "pinned Node binary changed");
  const dependencyInfo = await assertDirectory(DEPENDENCY_ROOT, 0o700, "pinned Mobile dependency root");
  assert.ok(dependencyInfo.isDirectory());
  assert.equal(await realpath(DEPENDENCY_ROOT), DEPENDENCY_ROOT, "dependency root must not traverse a symlink");
  const dependencyLockObservation = await readPinnedRegularWithStableMode(
    DEPENDENCY_LOCK_PATH,
    EXPECTED_DEPENDENCY_LOCK_SHA256,
    "pinned dependency lock",
  );
  const dependencyLock = dependencyLockObservation.bytes;
  const helperFiles = [];
  for (const [relativePath, expectedSha256] of EXPORT_HELPER_PINS) {
    const bytes = await readPinnedRegular(resolve(repoRoot, relativePath), expectedSha256, `E2E helper ${relativePath}`);
    helperFiles.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
  }
  const wrapperBytes = await readFile(new URL(import.meta.url));
  return {
    node: { ...NODE_PIN },
    dependency: {
      root: DEPENDENCY_ROOT,
      sourceTreeSha256: EXPECTED_DEPENDENCY_SOURCE_SHA256,
      ownedTreeSha256: EXPECTED_DEPENDENCY_OWNED_SHA256,
      lock: {
        relativePath: DEPENDENCY_LOCK_RELATIVE_PATH,
        size: dependencyLock.length,
        sha256: sha256(dependencyLock),
        modeBefore: dependencyLockObservation.modeBefore,
        modeAfter: dependencyLockObservation.modeAfter,
      },
    },
    helpers: helperFiles,
    wrapperSha256: sha256(wrapperBytes),
  };
}

function runRelative(context, path) {
  return relative(context.runRoot, path).split(sep).join("/");
}

await runE2E(import.meta.url, {
  testId: TEST_ID,
  tier: "full-integration",
  modelPolicy: "static Mobile Web source export only; no Browser, Gateway, Provider, or user session",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 20_000,
  survivorCheckTimeoutMs: 5_000,
  candidateSourceDigest: EXPECTED_CANDIDATE_DIGEST,
  candidateFileCount: EXPECTED_CANDIDATE_COUNT,
  dependencySourceTreeSha256: EXPECTED_DEPENDENCY_SOURCE_SHA256,
  nodeVersion: NODE_PIN.version,
}, async context => {
  const candidate = await verifyCandidate();
  const pinsBefore = await verifyRuntimePins();
  const verifiedRoot = context.pathInState("verified-worktree-handoff-static02-source");
  await lstat(verifiedRoot).then(() => assert.fail("verified source snapshot destination must be new"), error => {
    if (error?.code !== "ENOENT") throw error;
  });
  const copied = await copyVerifiedSnapshot({
    sourceRoot: CANDIDATE_ROOT,
    destination: verifiedRoot,
    expectedDigest: EXPECTED_CANDIDATE_DIGEST,
    expectedCount: EXPECTED_CANDIDATE_COUNT,
  });
  context.registerTemporaryDirectory("verified 315-file worktree handoff candidate", verifiedRoot);
  assert.equal(copied.status, "verified-copy");
  assert.equal(copied.sourceDigest, EXPECTED_CANDIDATE_DIGEST);
  assert.equal(copied.fileCount, EXPECTED_CANDIDATE_COUNT);

  const mobileRoot = resolve(verifiedRoot, "source/apps/kcoder-studio/mobile");
  const sharedRoot = resolve(verifiedRoot, "source/apps/kcoder-studio/shared");
  const exported = await exportMobileWeb(context, {
    mobileRoot,
    sourceRoots: [
      { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
    ],
    dependencyRoot: DEPENDENCY_ROOT,
    label: "worktree-handoff-static02",
    outputName: "mobile-web-worktree-handoff-static02",
    timeoutMs: 180_000,
  });
  assert.equal(exported.sourceTreeSha256, EXPECTED_CANDIDATE_DIGEST, "exporter saw different frozen source bytes");
  assert.equal(exported.dependencySourceTreeSha256, EXPECTED_DEPENDENCY_SOURCE_SHA256);
  assert.equal(exported.dependencyOwnedTreeSha256, EXPECTED_DEPENDENCY_OWNED_SHA256);
  assert.equal(exported.sourceRoots.find(root => root.name === "mobile")?.fileCount, 296);
  assert.equal(exported.sourceRoots.find(root => root.name === "studio-shared")?.fileCount, 19);

  const bundleManifest = JSON.parse(await readFile(exported.bundleManifestPath, "utf8"));
  assert.equal(bundleManifest.status, "complete", bundleManifest.error ?? "Mobile Web export failed");
  assert.equal(bundleManifest.sourceUnchanged, true);
  assert.equal(bundleManifest.snapshotCopyMatchesSource, true);
  assert.equal(bundleManifest.snapshotUnchangedDuringExport, true);
  assert.equal(bundleManifest.dependencyProvenance.sourceUnchanged, true);
  assert.equal(bundleManifest.terminalHookChangesOnlyGeneratedHtml, true);
  assert.ok(exported.bundleFiles.some(file => file.path === "index.html"), "Mobile Web export is missing index.html");

  const bundleRoot = context.pathInArtifacts("mobile-web-export-worktree-handoff-static02");
  await lstat(bundleRoot).then(() => assert.fail("portable bundle destination must be new"), error => {
    if (error?.code !== "ENOENT") throw error;
  });
  const portable = await copyFrozenMobileWeb({
    sourceRoot: exported.path,
    destination: bundleRoot,
    manifestPath: exported.bundleManifestPath,
    expectedBundleSha256: exported.bundleSha256,
    expectedSourceTreeSha256: EXPECTED_CANDIDATE_DIGEST,
    expectedDependencySourceTreeSha256: EXPECTED_DEPENDENCY_SOURCE_SHA256,
    expectedDependencyOwnedTreeSha256: EXPECTED_DEPENDENCY_OWNED_SHA256,
  });
  assert.equal(portable.status, "verified-copy");
  assert.equal(portable.fileCount, exported.bundleFileCount);
  assert.equal(portable.bundleSha256, exported.bundleSha256);

  const pinsAfter = await verifyRuntimePins();
  assert.deepEqual(pinsAfter, pinsBefore, "Node, helper, or dependency lock pins changed during export");
  const dependencyLockModeAcrossExport = {
    before: pinsBefore.dependency.lock.modeAfter,
    after: pinsAfter.dependency.lock.modeBefore,
  };
  assert.equal(
    dependencyLockModeAcrossExport.after,
    dependencyLockModeAcrossExport.before,
    "pinned dependency lock mode changed during export",
  );
  const afterCandidate = await verifyCandidate();
  assert.equal(afterCandidate.sourceDigest, candidate.sourceDigest, "frozen candidate changed during export");

  const reusableManifest = {
    schemaVersion: 1,
    purpose: "worktree handoff discovery static-02 source candidate Mobile Web export",
    sourceCommit: "09d1e88342909b36237a571774d2987fa2a8556c",
    candidateRoot: CANDIDATE_ROOT,
    candidateSourceDigest: EXPECTED_CANDIDATE_DIGEST,
    candidateFileCount: EXPECTED_CANDIDATE_COUNT,
    candidateManifestSha256: EXPECTED_CANDIDATE_MANIFEST_SHA256,
    candidateMetadataSha256: EXPECTED_METADATA_SHA256,
    baseManifestSha256: EXPECTED_BASE_MANIFEST_SHA256,
    baseSourceDigest: EXPECTED_BASE_SOURCE_DIGEST,
    overlayManifestSha256: EXPECTED_STATIC02_MANIFEST_SHA256,
    overlayDiffSha256: EXPECTED_STATIC02_DIFF_SHA256,
    overlayPath: "apps/kcoder-studio/mobile/src/app/new.tsx",
    overlaySha256: EXPECTED_STATIC02_SOURCE_SHA256,
    sourceTreeSha256: exported.sourceTreeSha256,
    sourceRoots: exported.sourceRoots,
    dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
    dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
    dependencyLockModeAcrossExport,
    bundleSha256: portable.bundleSha256,
    bundleFileCount: portable.fileCount,
    indexHtmlSha256: exported.indexHtmlSha256,
    directory: runRelative(context, bundleRoot),
    files: exported.bundleFiles,
    inputPins: pinsAfter,
  };
  const reusableManifestPath = await context.writeArtifactJson(
    "mobile-web-export-worktree-handoff-static02-reusable-manifest.schema1.json",
    reusableManifest,
  );
  return {
    status: "static-mobile-web-export-complete",
    candidateSourceDigest: candidate.sourceDigest,
    candidateFileCount: candidate.fileCount,
    overlayManifestSha256: EXPECTED_STATIC02_MANIFEST_SHA256,
    overlayDiffSha256: EXPECTED_STATIC02_DIFF_SHA256,
    overlayNewTsxSha256: EXPECTED_STATIC02_SOURCE_SHA256,
    sourceTreeSha256: exported.sourceTreeSha256,
    dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
    dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
    dependencyLockModeAcrossExport,
    bundleSha256: portable.bundleSha256,
    bundleFileCount: portable.fileCount,
    indexHtmlSha256: exported.indexHtmlSha256,
    bundlePath: runRelative(context, bundleRoot),
    bundleManifestPath: runRelative(context, exported.bundleManifestPath),
    reusableManifestPath: runRelative(context, reusableManifestPath),
    exporterPids: {
      dependencyCopier: exported.dependencyCopierPid,
      terminalHtmlBuilder: exported.terminalWebView.builderPid,
      expoExporter: bundleManifest.exporterPid,
    },
  };
});
