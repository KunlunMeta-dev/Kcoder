// Static-candidate exporter. It consumes one pinned source snapshot and the
// existing RunContext/export helpers; it does not launch Chromium or a Gateway.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { copyFrozenMobileWeb, copyVerifiedSnapshot } from "../harness/frozen-copy.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const TEST_ID = "mobile-web-export-transcript-list-geometry-static02";
const BASE_COMMIT = "09d1e88342909b36237a571774d2987fa2a8556c";
const CANDIDATE_ROOT = resolve(
  repoRoot,
  "target/private-phone-ux-implementation/mobile-web-export-transcript-list-geometry-static02-20261008",
);
const CANDIDATE_SOURCE_DIGEST = "26dc29b6b49042ac475178ecdecb5407c2519141a37c16a02b2cb483de7f9de4";
const CANDIDATE_FILE_COUNT = 317;
const CANDIDATE_METADATA_SHA256 = "90cf3c2ca770403048a3eec8bb8b38c1f2b121daaff18b2bd6d7cb61f54fe295";
const CANDIDATE_MANIFEST_SHA256 = "3342036f0fd497014f74bba1e44432424efbecbe15de77925d3b2fda9d67b8cd";
const STATIC02_MANIFEST_SHA256 = "a117da058ec2551a4b0293f45144b5be930b7e346d912d3af3eba79b7a2aaa25";
const STATIC02_API_SHA256 = "330e2d5443eea6ca4720144f4159421f32171a77cff83a68d144d1e36d5984d3";
const DEPENDENCY_ROOT =
  "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/private-phone-ux-implementation/mobile-dependency-input-pinned";
const DEPENDENCY_SOURCE_SHA256 = "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c";
const DEPENDENCY_LOCK_SHA256 = "67c2d1c16857f0ed0f6d2ecb3dcf753f26a268b0f1675c1553018e37e9d231a3";
const DEPENDENCY_LOCK_RELATIVE_PATH = ".package-lock.json";
const DEPENDENCY_OWNED_SHA256 = "754d1db10bd502faeb0b6e82820d455cae680166008a443f7397457f1ef21d29";
const NODE_PIN = {
  executable: "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node",
  version: "v22.17.0",
  sha256: "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9",
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runRelative(context, path) {
  return relative(context.runRoot, path).split(sep).join("/");
}

async function captureExportInputPins(metadata) {
  const lockPath = metadata.exporterInputPins.dependencyLock.relativePath;
  const lockBytes = await readFile(resolve(DEPENDENCY_ROOT, lockPath));
  const reusedHelpers = await Promise.all(metadata.exporterInputPins.reusedHelpers.map(async pin => {
    const bytes = await readFile(resolve(repoRoot, pin.path));
    return { path: pin.path, size: bytes.length, sha256: sha256(bytes) };
  }));
  return {
    dependencyLock: {
      relativePath: lockPath,
      size: lockBytes.length,
      sha256: sha256(lockBytes),
      note: metadata.exporterInputPins.dependencyLock.note,
    },
    reusedHelpers,
  };
}

await runE2E(import.meta.url, {
  testId: TEST_ID,
  candidateSourceDigest: CANDIDATE_SOURCE_DIGEST,
  candidateFileCount: CANDIDATE_FILE_COUNT,
  static02ManifestSha256: STATIC02_MANIFEST_SHA256,
  static02ApiSha256: STATIC02_API_SHA256,
  dependencySourceTreeSha256: DEPENDENCY_SOURCE_SHA256,
  nodeVersion: NODE_PIN.version,
}, async context => {
  assert.equal(process.execPath, NODE_PIN.executable, "export must use the pinned Node executable");
  assert.equal(process.version, NODE_PIN.version, "export must use the pinned Node version");
  assert.equal(sha256(await readFile(process.execPath)), NODE_PIN.sha256, "pinned Node binary changed");

  const metadataBytes = await readFile(resolve(CANDIDATE_ROOT, "metadata.json"));
  const candidateManifestBytes = await readFile(resolve(CANDIDATE_ROOT, "candidate-manifest.json"));
  const shaMapBytes = await readFile(resolve(CANDIDATE_ROOT, "sha256.json"));
  const overlayDiffBytes = await readFile(resolve(CANDIDATE_ROOT, "overlay.diff"));
  assert.equal(sha256(metadataBytes), CANDIDATE_METADATA_SHA256, "candidate metadata changed");
  assert.equal(sha256(candidateManifestBytes), CANDIDATE_MANIFEST_SHA256, "candidate file manifest changed");
  const metadata = JSON.parse(metadataBytes);
  const candidateManifest = JSON.parse(candidateManifestBytes);
  assert.equal(metadata.status, "STATIC_CANDIDATE_NOT_EXPORTED");
  assert.equal(metadata.base315.fileCount, 315);
  assert.equal(metadata.base315.physicalRawFileCount, 316);
  assert.equal(metadata.base315.excludedRawFiles[0].path, "apps/kcoder-studio/mobile/src/storage/device-secret-binding.test.ts");
  assert.equal(metadata.candidate.manifestSha256, CANDIDATE_MANIFEST_SHA256);
  assert.equal(metadata.candidate.sourceDigest, CANDIDATE_SOURCE_DIGEST);
  assert.equal(metadata.candidate.fileCount, CANDIDATE_FILE_COUNT);
  assert.equal(metadata.overlay.static02ManifestSha256, STATIC02_MANIFEST_SHA256);
  assert.equal(metadata.overlay.static02ApiSha256, STATIC02_API_SHA256);
  assert.equal(metadata.dependencyInput.sourceTreeSha256, DEPENDENCY_SOURCE_SHA256);
  assert.equal(metadata.dependencyInput.fileCount, 52_252);
  assert.equal(metadata.dependencyInput.lockFileRelativePath, DEPENDENCY_LOCK_RELATIVE_PATH);
  assert.equal(metadata.dependencyInput.packageLockSha256, DEPENDENCY_LOCK_SHA256);
  assert.equal(sha256(shaMapBytes), metadata.candidate.sha256MapSha256, "candidate file hash map changed");
  assert.equal(sha256(overlayDiffBytes), metadata.candidate.overlayDiffSha256, "candidate overlay diff changed");
  assert.equal(candidateManifest.sourceDigest, CANDIDATE_SOURCE_DIGEST);
  assert.equal(candidateManifest.fileCount, CANDIDATE_FILE_COUNT);
  assert.equal(candidateManifest.base.fileCount, 315);
  assert.equal(candidateManifest.base.physicalRawFileCount, 316);
  assert.equal(candidateManifest.sourceSelection.baseDeclaredFileCount, 315);
  assert.equal(candidateManifest.sourceSelection.basePhysicalRawFileCount, 316);
  assert.deepEqual(candidateManifest.sourceSelection.excludedRawFiles, metadata.base315.excludedRawFiles);
  assert.equal(candidateManifest.base.sourceManifestSha256, metadata.base315.sourceManifestSha256);

  const inputPinsBefore = await captureExportInputPins(metadata);
  assert.deepEqual(inputPinsBefore, metadata.exporterInputPins, "export dependency lock/helper source pins changed");

  const verifiedRoot = context.pathInState("verified-static-candidate");
  const verified = await copyVerifiedSnapshot({
    sourceRoot: CANDIDATE_ROOT,
    destination: verifiedRoot,
    expectedDigest: CANDIDATE_SOURCE_DIGEST,
    expectedCount: CANDIDATE_FILE_COUNT,
  });
  context.registerTemporaryDirectory("verified transcript geometry source snapshot", verifiedRoot);
  assert.equal(verified.status, "verified-copy");
  assert.equal(verified.sourceDigest, CANDIDATE_SOURCE_DIGEST);
  assert.equal(verified.fileCount, CANDIDATE_FILE_COUNT);

  const mobileRoot = resolve(verifiedRoot, "source/apps/kcoder-studio/mobile");
  const sharedRoot = resolve(verifiedRoot, "source/apps/kcoder-studio/shared");
  const exported = await exportMobileWeb(context, {
    mobileRoot,
    sourceRoots: [
      { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
    ],
    dependencyRoot: DEPENDENCY_ROOT,
    label: "transcript-list-geometry-static02",
    outputName: "mobile-web-transcript-list-geometry-static02",
  });
  assert.equal(exported.sourceTreeSha256, CANDIDATE_SOURCE_DIGEST);
  assert.equal(exported.dependencySourceTreeSha256, DEPENDENCY_SOURCE_SHA256);
  assert.equal(exported.dependencyOwnedTreeSha256, DEPENDENCY_OWNED_SHA256);

  const artifactBundle = context.pathInArtifacts("mobile-web-transcript-list-geometry-static02");
  const portable = await copyFrozenMobileWeb({
    sourceRoot: exported.path,
    destination: artifactBundle,
    manifestPath: exported.bundleManifestPath,
    expectedBundleSha256: exported.bundleSha256,
    expectedSourceTreeSha256: exported.sourceTreeSha256,
    expectedDependencySourceTreeSha256: exported.dependencySourceTreeSha256,
    expectedDependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
  });
  assert.equal(portable.status, "verified-copy");
  assert.equal(portable.bundleSha256, exported.bundleSha256);
  assert.equal(portable.fileCount, exported.bundleFileCount);

  const inputPinsAfter = await captureExportInputPins(metadata);
  const inputPinsUnchanged = JSON.stringify(inputPinsAfter) === JSON.stringify(inputPinsBefore);
  const inputPinProvenancePath = await context.writeArtifactJson("mobile-web-export-input-provenance.json", {
    status: "checked-before-after-export",
    dependencyRoot: DEPENDENCY_ROOT,
    dependencyLockRelativePath: DEPENDENCY_LOCK_RELATIVE_PATH,
    expectedDependencyLockSha256: DEPENDENCY_LOCK_SHA256,
    expected: metadata.exporterInputPins,
    before: inputPinsBefore,
    after: inputPinsAfter,
    unchanged: inputPinsUnchanged,
  });
  assert.deepEqual(inputPinsAfter, inputPinsBefore, "dependency lock or reused E2E helper source changed during export");

  const reusableManifest = {
    schemaVersion: 1,
    purpose: "frozen inverted transcript geometry static-02 Mobile Web candidate export",
    sourceCommit: BASE_COMMIT,
    sourceTreeSha256: exported.sourceTreeSha256,
    bundleSha256: exported.bundleSha256,
    bundleFileCount: exported.bundleFileCount,
    indexHtmlSha256: exported.indexHtmlSha256,
    directory: runRelative(context, artifactBundle),
    files: exported.bundleFiles,
  };
  const reusableManifestPath = await context.writeArtifactJson(
    "mobile-web-export-transcript-list-geometry-schema1.json",
    reusableManifest,
  );

  return {
    sourceCommit: BASE_COMMIT,
    candidateSourceDigest: CANDIDATE_SOURCE_DIGEST,
    candidateFileCount: CANDIDATE_FILE_COUNT,
    base315ManifestSha256: metadata.base315.sourceManifestSha256,
    base315DeclaredFiles: metadata.base315.fileCount,
    base315PhysicalRawFiles: metadata.base315.physicalRawFileCount,
    excludedRawBaseFixture: metadata.base315.excludedRawFiles[0],
    static02ManifestSha256: STATIC02_MANIFEST_SHA256,
    static02ApiSha256: STATIC02_API_SHA256,
    dependencyLockRelativePath: DEPENDENCY_LOCK_RELATIVE_PATH,
    dependencyLockSha256: inputPinsAfter.dependencyLock.sha256,
    reusedHelperSourceSha256: inputPinsAfter.reusedHelpers,
    inputPinProvenancePath: runRelative(context, inputPinProvenancePath),
    sourceTreeSha256: exported.sourceTreeSha256,
    dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
    dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
    bundleSha256: exported.bundleSha256,
    bundleFileCount: exported.bundleFileCount,
    indexHtmlSha256: exported.indexHtmlSha256,
    bundlePath: runRelative(context, artifactBundle),
    reusableManifestPath: runRelative(context, reusableManifestPath),
    reusableManifestSchemaVersion: reusableManifest.schemaVersion,
  };
});
