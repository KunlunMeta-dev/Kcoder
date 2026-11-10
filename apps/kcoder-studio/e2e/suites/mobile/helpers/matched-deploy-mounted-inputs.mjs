import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { buildGatewayMobileWebManifest } from "../../../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { copyOfficialMobileStaticDist, inspectOfficialMobileStaticDist } from "../../../harness/mobile-static-dist-input.mjs";
import { resolveExistingPrivatePath } from "../../../harness/gateway-runtime-snapshot-guard.mjs";
import { repoRoot } from "../../../harness/run-context.mjs";

// These pins describe one historical paired comparison. The current official
// dist path keeps its own current-source receipt and builder verification.
const MATCHED_BEFORE_SOURCE_ADAPTER = "target/private-phone-ux-implementation/matched-before-10feb-source-adapter-20261009";
const MATCHED_BEFORE_SOURCE_TREE_SHA256 = "b6798c23678c3b4a362c4e6024da536fa9c101df471c375ab202343ca96f1985";
const MATCHED_BEFORE_COMPLEMENT_SHA256 = "eded1c4c5e1c27960a951945b5a6d49d653e8d534a76019b22ec9cb6ab15226b";
const MATCHED_AFTER_SOURCE_ADAPTER = "target/private-official-export-receipt-wiring-20261009/source-adapter-9925461c";
const MATCHED_AFTER_SOURCE_DIGEST = "7d64b37bb56592f3e33dc222af0e58bf3a2cf44b72261092c42339acd30d935e";
const MATCHED_AFTER_PACKAGE_LOCK_SHA256 = "7c47b7ad5427ac56682f19c6fb7e46cff6e442ad8f52edee283665a38cd2e68b";
const MATCHED_EXPORT_RUN_ROOT = "target/private-phone-ux-validation/new-common-dependencies-before10feb-after992-20261009/run-d065c8c452c648f7";
const MATCHED_EXPORT_MANIFEST_SHA256 = Object.freeze({
  before: "ddc3812c3987d1c86608ee252f1313438a4ae4f9a66e44056466fa3c3082c615",
  after: "f2f262624d4a2286ef31e250fb1752e02ab9a41232196b5591dafc5d8369d14d",
});
const MATCHED_EXPORT_BUNDLE_SHA256 = Object.freeze({
  before: "814743e602a67d2ec3b73956102804089332964540a152a2ede253218d76752b",
  after: "e4a7277de6ecb2afb8f68dee52dfdf3b5a270c0e0c2e7f46cbdba02e83e140ab",
});
const MATCHED_COMMON_DEPENDENCY_SOURCE_SHA256 = "46b02fc5ac823118f6eb2c034ea3f1d9cbbf79b71041fc2fa848f79a9abca1c6";
const MATCHED_COMMON_DEPENDENCY_COPY_SHA256 = "51b0c6987324fa5b6dbc17d8ea34ff83dd832deaa06c9c1193f84465a89001e4";
const MATCHED_COMMON_DEPENDENCY_FILE_COUNT = 52_524;
export const MATCHED_DEPLOY_MOUNTED_PINS = Object.freeze({
  beforeSourceAdapter: MATCHED_BEFORE_SOURCE_ADAPTER,
  beforeSourceTreeSha256: MATCHED_BEFORE_SOURCE_TREE_SHA256,
  beforeComplementSha256: MATCHED_BEFORE_COMPLEMENT_SHA256,
  afterSourceAdapter: MATCHED_AFTER_SOURCE_ADAPTER,
  afterSourceDigest: MATCHED_AFTER_SOURCE_DIGEST,
  afterPackageLockSha256: MATCHED_AFTER_PACKAGE_LOCK_SHA256,
  exportRunRoot: MATCHED_EXPORT_RUN_ROOT,
  exportManifestSha256: MATCHED_EXPORT_MANIFEST_SHA256,
  exportBundleSha256: MATCHED_EXPORT_BUNDLE_SHA256,
  commonDependencySourceSha256: MATCHED_COMMON_DEPENDENCY_SOURCE_SHA256,
  commonDependencyCopySha256: MATCHED_COMMON_DEPENDENCY_COPY_SHA256,
  commonDependencyFileCount: MATCHED_COMMON_DEPENDENCY_FILE_COUNT,
});

export function selectMatchedDeployMountedModes(argv) {
  const reuseDeployMountedMode = argv.includes("--reuse-deploy-mounted");
  const reuseMatchedDeployMountedFormalMode = argv.includes("--reuse-matched-deploy-mounted-formal");
  return {
    reuseDeployMountedMode,
    reuseMatchedDeployMountedFormalMode,
    matchedDeployMountedInputMode: reuseDeployMountedMode || reuseMatchedDeployMountedFormalMode,
  };
}

export function validateMatchedDeployMountedInputs(input) {
  const modes = selectMatchedDeployMountedModes(input.argv);
  const {
    reuseDeployMountedMode,
    reuseMatchedDeployMountedFormalMode,
    matchedDeployMountedInputMode,
  } = modes;
  const {
    repoRoot: root,
    snapshotMode,
    snapshotDirectory,
    snapshotSourceSha256,
    beforeComplementDirectory,
    beforeComplementSha256,
    reuseExportDirectory,
    reuseExportManifest,
    reuseExportManifestSha256,
    currentOfficialDistMode,
    refreshSmokeMode,
    refreshSingleSampleMode,
    refreshHomeN30OnlyMode,
    refreshSendDiagnosticMode,
    refreshBackgroundDiagnosticMode,
    refreshAuthCleanupUiGateMode,
    refreshSendDiagnostic,
    refreshBackgroundDiagnostic,
    navigationOnly,
    drawerCloseDiagnosticsEnabled,
    sampleCount,
    delayValues,
    defaultSamples,
    defaultDelays,
  } = input;
  assert.equal(reuseDeployMountedMode && reuseMatchedDeployMountedFormalMode, false, "choose either paired deploy-mounted smoke or formal mode");
  if (matchedDeployMountedInputMode) {
    assert.equal(currentOfficialDistMode, false, "reused matched deploy-mount inputs cannot use the current-official-dist selector");
    assert.ok(reuseExportDirectory && reuseExportManifest, "matched deploy-mounted modes require both reuse-export inputs");
    assert.ok(reuseExportManifestSha256, "matched deploy-mounted modes require an exact reused manifest SHA-256 pin");
    assert.ok(snapshotDirectory && snapshotSourceSha256, "matched deploy-mounted modes require an exact matched Mobile/shared source snapshot and digest");
    if (reuseDeployMountedMode) {
      assert.equal(refreshSmokeMode, true, "--reuse-deploy-mounted remains reserved for the paired zero-delay functional smoke");
    } else {
      assert.equal(refreshSmokeMode, false, "formal matched deploy-mounted mode is not a smoke run");
      assert.equal(refreshSingleSampleMode, false, "formal matched deploy-mounted mode cannot be diagnostic, smoke, or auth-only");
      assert.equal(refreshHomeN30OnlyMode, false, "formal matched deploy-mounted mode runs all four actions");
      assert.equal(refreshSendDiagnosticMode, false, "formal matched deploy-mounted mode cannot select a send diagnostic");
      assert.equal(refreshBackgroundDiagnosticMode, false, "formal matched deploy-mounted mode cannot select a background diagnostic");
      assert.equal(refreshAuthCleanupUiGateMode, false, "formal matched deploy-mounted mode cannot select the auth-only gate");
      assert.equal(refreshSendDiagnostic, null, "formal matched deploy-mounted mode cannot accept a send diagnostic selector");
      assert.equal(refreshBackgroundDiagnostic, null, "formal matched deploy-mounted mode cannot accept a background diagnostic selector");
      assert.equal(navigationOnly, false, "formal matched deploy-mounted mode must retain all interaction and response assertions");
      assert.equal(drawerCloseDiagnosticsEnabled, false, "formal matched deploy-mounted mode cannot replace the full flow with drawer diagnostics");
      assert.equal(sampleCount, defaultSamples, "formal matched deploy-mounted mode requires 30 samples per action and delay bin");
      assert.deepEqual(delayValues, defaultDelays, "formal matched deploy-mounted mode requires the 0/300/600/1000ms bins");
    }
    assert.equal(reuseExportManifestSha256, MATCHED_EXPORT_MANIFEST_SHA256[snapshotMode], "matched deploy-mounted mode requires the exact selected before/after manifest digest");
    const sourceLabel = snapshotMode === "before" ? "before-10feb" : "comparison-9925461c";
    const matchedExportRoot = resolve(root, MATCHED_EXPORT_RUN_ROOT);
    assert.equal(resolve(root, reuseExportDirectory), resolve(matchedExportRoot, sourceLabel, "bundle"), "matched deploy-mounted mode must use the exact paired before/after bundle path");
    assert.equal(resolve(root, reuseExportManifest), resolve(matchedExportRoot, sourceLabel, "export-manifest.json"), "matched deploy-mounted mode must use the exact paired before/after manifest path");
    if (snapshotMode === "before") {
      assert.equal(resolve(root, snapshotDirectory), resolve(root, MATCHED_BEFORE_SOURCE_ADAPTER), "matched before mode must use the frozen 10feb Git source adapter");
      assert.equal(snapshotSourceSha256, MATCHED_BEFORE_SOURCE_TREE_SHA256, "matched before source tree digest changed");
      assert.equal(beforeComplementDirectory, MATCHED_BEFORE_SOURCE_ADAPTER, "matched before mode must name the exact pinned complement tree");
      assert.equal(resolve(root, beforeComplementDirectory), resolve(root, MATCHED_BEFORE_SOURCE_ADAPTER), "matched before mode must copy the exact pinned complement tree");
      assert.equal(beforeComplementSha256, MATCHED_BEFORE_COMPLEMENT_SHA256, "matched before complement digest changed");
    } else {
      assert.equal(resolve(root, snapshotDirectory), resolve(root, MATCHED_AFTER_SOURCE_ADAPTER), "matched after mode must use the frozen Git992 source adapter");
      assert.equal(snapshotSourceSha256, MATCHED_AFTER_SOURCE_DIGEST, "matched after source adapter digest changed");
      assert.equal(beforeComplementDirectory, null, "matched after mode cannot accept a before complement");
      assert.equal(beforeComplementSha256, null, "matched after mode cannot accept a before complement digest");
    }
  } else {
    assert.equal(reuseExportManifestSha256, null, "--reuse-export-manifest-sha256 is only accepted with a paired deploy-mounted mode");
  }
  return modes;
}

async function resolvePrivateBeforeComplementRoot(requestedDirectory) {
  const canonicalRepoRoot = await realpath(repoRoot);
  const privateInputRoot = resolve(canonicalRepoRoot, "target/private-phone-ux-implementation");
  const requestedRoot = resolve(canonicalRepoRoot, requestedDirectory);
  assert.ok(requestedRoot.startsWith(privateInputRoot + sep), "--before-complement-dir must be below target/private-phone-ux-implementation");
  const canonicalPrivateInputRoot = await realpath(privateInputRoot);
  const canonicalRequestedRoot = await realpath(requestedRoot);
  assert.ok(canonicalRequestedRoot.startsWith(canonicalPrivateInputRoot + sep), "--before-complement-dir canonical path escapes target/private-phone-ux-implementation");
  assert.equal(canonicalRequestedRoot, requestedRoot, "--before-complement-dir must not traverse symlinked paths");
  const requestedInfo = await lstat(requestedRoot);
  assert.ok(requestedInfo.isDirectory() && !requestedInfo.isSymbolicLink(), "--before-complement-dir must be an existing regular directory");
  return canonicalRequestedRoot;
}

export async function prepareMobileSourceSnapshot(context, mode, currentMobileRoot, currentSharedRoot, snapshotDirectory, expectedSourceDigest, beforeComplementDirectory, beforeComplementSha256, officialPackageLockSha256, options = {}) {
  const {
    matchedDeployMountedInputMode = false,
    currentOfficialDistMode = false,
    reuseExportDirectory = null,
    reuseExportManifest = null,
    currentOfficialDistDependencyLockSha256,
  } = options;
  const snapshotRoot = resolve(repoRoot, snapshotDirectory || `target/private-phone-latency-implementation/${mode}`);
  assert.ok(snapshotRoot.startsWith(`${repoRoot}${sep}`), "frozen source directory must remain inside the repository target tree");
  const manifestPath = resolve(snapshotRoot, "sha256.json");
  if (matchedDeployMountedInputMode) {
    const expectedRoot = resolve(repoRoot, mode === "before" ? MATCHED_BEFORE_SOURCE_ADAPTER : MATCHED_AFTER_SOURCE_ADAPTER);
    assert.equal(snapshotRoot, expectedRoot, "matched source snapshot path changed");
    assert.equal(await realpath(snapshotRoot), snapshotRoot, "matched source snapshot must not traverse a symlink");
    const manifestInfo = await lstat(manifestPath);
    assert.ok(manifestInfo.isFile() && !manifestInfo.isSymbolicLink(), "matched source SHA-256 inventory must be a regular file");
    assert.equal(await realpath(manifestPath), manifestPath, "matched source SHA-256 inventory must not traverse a symlink");
  }
  await access(manifestPath);
  const manifestBytes = await readFile(manifestPath);
  const hashes = JSON.parse(manifestBytes.toString("utf8"));
  assert.ok(hashes && typeof hashes === "object" && !Array.isArray(hashes), "frozen source manifest must map repository-relative paths to SHA-256 values");
  const entries = Object.entries(hashes);
  assert.ok(entries.length > 0, "frozen source manifest is empty");
  const mobilePackageLockPath = "apps/kcoder-studio/mobile/package-lock.json";
  if (matchedDeployMountedInputMode && mode === "before") {
    assert.equal(Object.hasOwn(hashes, mobilePackageLockPath), false, "the matched 10feb before adapter intentionally keeps its package lock in the separately verified complement");
  }
  if (matchedDeployMountedInputMode && mode === "after") {
    assert.equal(hashes[mobilePackageLockPath], MATCHED_AFTER_PACKAGE_LOCK_SHA256, "matched Git992 source adapter package-lock SHA-256 changed");
  }
  let matchedPackageLockSha256 = null;
  for (const [path, hash] of entries) {
    const validBeforePath = path.startsWith("apps/kcoder-studio/mobile/") || path.startsWith("apps/kcoder-studio/shared/");
    const validAfterPath = path.startsWith("apps/kcoder-studio/") || path.startsWith("apps/kcoder-relay/");
    assert.ok(mode === "before" ? validBeforePath : validAfterPath, `unexpected frozen-source path: ${path}`);
    const pathSegments = path.split("/");
    assert.equal(pathSegments.includes("node_modules"), false, `frozen source must not include dependencies: ${path}`);
    assert.equal(pathSegments.some(segment => segment.startsWith(".env")), false, `frozen source must not include dotenv credentials: ${path}`);
    const isDependencyLockfile = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path);
    const expectedStaticMobilePackageLockSha256 = currentOfficialDistMode
      ? officialPackageLockSha256 ?? currentOfficialDistDependencyLockSha256
      : matchedDeployMountedInputMode && mode === "after"
        ? MATCHED_AFTER_PACKAGE_LOCK_SHA256
        : "848076f520f165128b601b27d96d4d32cf25e8929ee54b672f198b9a4c224e26";
    const isPinnedStaticMobilePackageLock = mode === "after"
      && (currentOfficialDistMode || (Boolean(reuseExportDirectory) && Boolean(reuseExportManifest)))
      && path === "apps/kcoder-studio/mobile/package-lock.json"
      && hash === expectedStaticMobilePackageLockSha256;
    assert.ok(!isDependencyLockfile || isPinnedStaticMobilePackageLock, `frozen source may only retain the exact pinned Mobile package-lock as static metadata for after-mode export reuse or current official dist: ${path}`);
    assert.match(hash, /^[a-f0-9]{64}$/, `invalid frozen-source digest for ${path}`);
    if (path === mobilePackageLockPath && matchedDeployMountedInputMode && mode === "after") matchedPackageLockSha256 = hash;
  }
  let freezeMetadataSha256 = null;
  let frozenSourceDigest = null;
  if (mode === "before" && matchedDeployMountedInputMode) {
    const metadataPath = resolve(snapshotRoot, "source-adapter.json");
    const metadataInfo = await lstat(metadataPath);
    assert.ok(metadataInfo.isFile() && !metadataInfo.isSymbolicLink(), "matched before source-adapter metadata must be a regular file");
    assert.equal(await realpath(metadataPath), metadataPath, "matched before source-adapter metadata must not traverse a symlink");
    const metadataBytes = await readFile(metadataPath);
    const adapterMetadata = JSON.parse(metadataBytes.toString("utf8"));
    freezeMetadataSha256 = sha256(metadataBytes);
    frozenSourceDigest = adapterMetadata.sourceTreeSha256 ?? null;
    assert.equal(adapterMetadata.status, "complete", "matched before source-adapter metadata must be complete");
    assert.equal(adapterMetadata.inputKind, "pinned-git-source-adapter-for-matched-before-export");
    assert.equal(adapterMetadata.sourceCommit, "10feb0e049e4a3de3aef6c2ecf011e2cac55c66d");
    assert.equal(frozenSourceDigest, expectedSourceDigest, "matched before source tree does not match its explicit digest pin");
    assert.equal(adapterMetadata.sha256ManifestSha256, sha256(manifestBytes), "matched before source-adapter metadata does not bind its SHA-256 inventory");
    assert.equal(adapterMetadata.beforeComplementSha256, beforeComplementSha256, "matched before source-adapter metadata does not bind its complement tree");
    assert.equal(adapterMetadata.packageLock?.executed, false, "matched before adapter must not execute its static package lock");
    assert.equal(adapterMetadata.rawGitBlobCount, 314, "matched before adapter Git blob count changed");
    assert.equal(adapterMetadata.copiedExportInputCount, 313, "matched before adapter export input count changed");
    assert.equal(adapterMetadata.snapshotOverlayFileCount, entries.length, "matched before adapter overlay inventory count changed");
    assert.equal(entries.length, 312, "matched before source overlay must retain its exact selected inventory size");
  } else if (mode === "after") {
    const freezePath = resolve(snapshotRoot, "freeze.json");
    const metadataPath = resolve(snapshotRoot, "metadata.json");
    const freezeBytes = await readFile(freezePath).catch(async error => {
      if (error?.code !== "ENOENT") throw error;
      return readFile(metadataPath);
    });
    const freezeMetadata = JSON.parse(freezeBytes.toString("utf8"));
    freezeMetadataSha256 = sha256(freezeBytes);
    frozenSourceDigest = freezeMetadata.sourceDigest ?? freezeMetadata.manifestDigest ?? null;
    assert.match(String(frozenSourceDigest), /^[a-f0-9]{64}$/, "after freeze metadata must contain a source digest");
    if (freezeMetadata.manifestDigest) {
      assert.equal(freezeMetadata.manifestDigest, sha256(manifestBytes), "after freeze metadata does not match sha256.json");
    }
    if (expectedSourceDigest) assert.equal(frozenSourceDigest, expectedSourceDigest, "after freeze source digest does not match the explicitly pinned candidate");
    const expectedFileCount = freezeMetadata.sourceFiles ?? freezeMetadata.count ?? freezeMetadata.files;
    assert.equal(entries.length, Number(expectedFileCount), "after source file count does not match freeze metadata");
  }

  const sourceRoot = context.pathInState(`mobile-source-${mode}`);
  const mobileRoot = resolve(sourceRoot, "apps/kcoder-studio/mobile");
  const sharedRoot = resolve(sourceRoot, "apps/kcoder-studio/shared");
  await mkdir(mobileRoot, { recursive: true, mode: 0o700 });
  await mkdir(sharedRoot, { recursive: true, mode: 0o700 });
  context.registerTemporaryDirectory(`sanitized Mobile/shared source for ${mode}`, sourceRoot);
  const excludedContent = Object.create(null);
  let complementSource = null;
  let complementShaBeforeOverlay = null;
  if (mode === "before") {
    if (beforeComplementDirectory) {
      const pinnedComplementRoot = await resolvePrivateBeforeComplementRoot(beforeComplementDirectory);
      const pinnedMobileRoot = resolve(pinnedComplementRoot, "apps/kcoder-studio/mobile");
      const pinnedSharedRoot = resolve(pinnedComplementRoot, "apps/kcoder-studio/shared");
      for (const pinnedRoot of [pinnedMobileRoot, pinnedSharedRoot]) {
        const pinnedInfo = await lstat(pinnedRoot);
        assert.ok(pinnedInfo.isDirectory() && !pinnedInfo.isSymbolicLink(), "private before-complement Mobile/shared roots must be regular directories");
      }
      const sourceSha256BeforeCopy = await hashComplement(pinnedMobileRoot, pinnedSharedRoot);
      assert.equal(sourceSha256BeforeCopy, beforeComplementSha256, "private before-complement source does not match --before-complement-sha256");
      await copySanitizedTree(pinnedMobileRoot, mobileRoot, excludedContent);
      await copySanitizedTree(pinnedSharedRoot, sharedRoot, excludedContent);
      const sourceSha256AfterCopy = await hashComplement(pinnedMobileRoot, pinnedSharedRoot);
      assert.equal(sourceSha256AfterCopy, sourceSha256BeforeCopy, "private before-complement source changed while it was being copied");
      complementShaBeforeOverlay = await hashComplement(mobileRoot, sharedRoot);
      assert.equal(complementShaBeforeOverlay, beforeComplementSha256, "copied private before-complement does not match the supplied SHA-256");
      complementSource = {
        directory: relative(repoRoot, pinnedComplementRoot),
        expectedSha256: beforeComplementSha256,
        sourceSha256BeforeCopy,
        sourceSha256AfterCopy,
        copiedSha256: complementShaBeforeOverlay,
        sourceStableDuringCopy: sourceSha256BeforeCopy === sourceSha256AfterCopy,
      };
    } else {
      await copySanitizedTree(currentMobileRoot, mobileRoot, excludedContent);
      await copySanitizedTree(currentSharedRoot, sharedRoot, excludedContent);
      complementShaBeforeOverlay = await hashComplement(mobileRoot, sharedRoot);
    }
  }

  const expectedMobileSrc = new Set(entries
    .map(([path]) => path.startsWith("apps/kcoder-studio/mobile/src/") ? path.slice("apps/kcoder-studio/mobile/src/".length) : null)
    .filter(Boolean));
  const currentMobileSrc = resolve(mobileRoot, "src");
  const currentSrcFiles = mode === "before" ? await listFiles(currentMobileSrc) : [];
  if (mode === "before") {
    // The before SHA list freezes the complete Mobile/src tree. Remove any
    // source added after that freeze before restoring the frozen file bytes.
    for (const path of currentSrcFiles) {
      if (!expectedMobileSrc.has(path)) await rm(resolve(currentMobileSrc, path), { force: true });
    }
    await pruneEmptyDirectories(currentMobileSrc);
  }
  let overlay = [];
  for (const [path, expectedHash] of entries) {
    const source = resolve(snapshotRoot, path);
    const destination = resolve(sourceRoot, path);
    assert.ok(destination.startsWith(`${sourceRoot}${sep}`), "frozen source path escaped the private E2E state directory");
    if (matchedDeployMountedInputMode) {
      const sourceInfo = await lstat(source);
      assert.ok(sourceInfo.isFile() && !sourceInfo.isSymbolicLink(), `matched source entry must be a regular file: ${path}`);
      assert.equal(await realpath(source), source, `matched source entry must not traverse a symlink: ${path}`);
    }
    const sourceBytes = await readFile(source);
    const actualHash = sha256(sourceBytes);
    assert.equal(actualHash, expectedHash, `frozen before/after source hash mismatch for ${path}`);
    await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    overlay.push({ path, sha256: actualHash });
  }
  if (matchedDeployMountedInputMode && mode === "after") {
    const copiedPackageLockSha256 = sha256(await readFile(resolve(mobileRoot, "package-lock.json")));
    assert.equal(copiedPackageLockSha256, MATCHED_AFTER_PACKAGE_LOCK_SHA256, "copied Git992 package-lock differs from the pinned source-adapter file");
    assert.equal(copiedPackageLockSha256, matchedPackageLockSha256, "copied Git992 package-lock differs from the source-adapter inventory entry");
    matchedPackageLockSha256 = copiedPackageLockSha256;
  }
  const complementShaAfterOverlay = mode === "before" ? await hashComplement(mobileRoot, sharedRoot) : null;
  if (mode === "before") assert.equal(complementShaAfterOverlay, complementShaBeforeOverlay, "the frozen overlay unexpectedly changed a complement file");
  if (beforeComplementSha256) assert.equal(complementShaAfterOverlay, beforeComplementSha256, "before complement SHA-256 changed during the frozen 224-file overlay");
  const completeness = {
    mobileSrcExpected: expectedMobileSrc.size,
    mobileSrcRestored: overlay.filter(item => item.path.startsWith("apps/kcoder-studio/mobile/src/")).length,
    mobileSrcFilesRemovedSinceFreezeCount: currentSrcFiles.filter(path => !expectedMobileSrc.has(path)).length,
    manifestFileCount: entries.length,
    workspaceComplementCopied: mode === "before" && !beforeComplementDirectory,
    privateBeforeComplementCopied: Boolean(complementSource),
    complementSource: mode === "before"
      ? complementSource
        ? `copied from verified private source ${complementSource.directory}; source-before, source-after, and copied hashes matched ${complementSource.expectedSha256}`
        : "copied from the current workspace and identified by SHA-256; writer confirmed build-affecting complement files were unchanged"
      : currentOfficialDistMode
        ? `no active-workspace complement copied; the exact ${entries.length}-file after freeze is copied and hash-verified. The pinned Mobile package-lock is static metadata only and is not executed; the separately copied 37-file current official Mobile dist is verified against its builder manifest. No Expo export or dependency snapshot is created in this mode.`
        : `no active-workspace complement copied; the exact ${entries.length}-file after freeze is copied and hash-verified. The one pinned Mobile package-lock remains static source metadata and is never executed or used to install dependencies on this reuse-only path; the Mobile/shared roots and 37-file bundle are checked against the reused export, with dependency trees separately pinned by its provenance.`,
  };
  assert.equal(completeness.mobileSrcExpected, completeness.mobileSrcRestored, "the frozen manifest does not cover every Mobile/src file");
  if (mode === "after") assert.equal(overlay.length, entries.length, "after source snapshot must contain exactly every frozen file");
  return {
    mobileRoot,
    sharedRoot,
    snapshotRoot,
    manifestSha256: sha256(manifestBytes),
    freezeMetadataSha256,
    frozenSourceDigest,
    entryCount: entries.length,
    matchedPackageLockSha256,
    overlaySha256: sha256(Buffer.from(JSON.stringify(overlay))),
    complementSha256: complementShaAfterOverlay,
    complementSource,
    completeness,
    excludedContentCounts: excludedContent,
  };
}

export async function reuseMobileWebExport(context, sourceSnapshot, bundleDirectory, manifestArgument, expectedManifestSha256 = null, options = {}) {
  const { snapshotMode, matchedDeployMountedInputMode = false, resourceCount } = options;
  let bundleRoot = resolve(repoRoot, bundleDirectory);
  const runArtifactsRoot = resolve(repoRoot, "target/test");
  const privateInputRoot = resolve(repoRoot, "target/private-phone-ux-implementation");
  const matchedExportRunRoot = resolve(repoRoot, MATCHED_EXPORT_RUN_ROOT);
  let manifestPath = resolve(repoRoot, manifestArgument || resolve(bundleRoot, "..", `mobile-web-export-mobile-high-latency-${snapshotMode}-manifest.json`));
  const bundleIsRunArtifact = bundleRoot.startsWith(`${runArtifactsRoot}${sep}`);
  const manifestIsRunArtifact = manifestPath.startsWith(`${runArtifactsRoot}${sep}`);
  const bundleIsPrivateInput = bundleRoot.startsWith(`${privateInputRoot}${sep}`);
  const manifestIsPrivateInput = manifestPath.startsWith(`${privateInputRoot}${sep}`);
  if (matchedDeployMountedInputMode) {
    const sourceLabel = snapshotMode === "before" ? "before-10feb" : "comparison-9925461c";
    const expectedBundleRoot = resolve(matchedExportRunRoot, sourceLabel, "bundle");
    const expectedManifestPath = resolve(matchedExportRunRoot, sourceLabel, "export-manifest.json");
    assert.equal(bundleRoot, expectedBundleRoot, "matched deploy-mounted smoke must use the pinned before/after bundle path");
    assert.equal(manifestPath, expectedManifestPath, "matched deploy-mounted smoke must use the pinned before/after export manifest path");
    for (const path of [matchedExportRunRoot, bundleRoot, manifestPath]) {
      assert.equal(await realpath(path), path, "matched export input path must not traverse a symlink");
    }
    const bundleInfo = await lstat(bundleRoot);
    const manifestInfo = await lstat(manifestPath);
    assert.ok(bundleInfo.isDirectory() && !bundleInfo.isSymbolicLink(), "matched Mobile Web bundle must be an existing regular directory");
    assert.ok(manifestInfo.isFile() && !manifestInfo.isSymbolicLink(), "matched Mobile Web export manifest must be an existing regular file");
  } else if (bundleIsRunArtifact && manifestIsRunArtifact) {
    // Existing target/test artifacts remain supported for one-off inspection.
  } else {
    assert.ok(bundleIsPrivateInput && manifestIsPrivateInput, "reused Mobile Web bundle and manifest must both come from target/test or explicitly selected target/private-phone-ux-implementation inputs");
    bundleRoot = await resolveExistingPrivatePath(repoRoot, bundleRoot);
    manifestPath = await resolveExistingPrivatePath(repoRoot, manifestPath);
    const bundleInfo = await lstat(bundleRoot);
    const manifestInfo = await lstat(manifestPath);
    assert.ok(bundleInfo.isDirectory() && !bundleInfo.isSymbolicLink(), "private Mobile Web bundle must be an existing regular directory");
    assert.ok(manifestInfo.isFile() && !manifestInfo.isSymbolicLink(), "private Mobile Web export manifest must be an existing regular file");
  }
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  if (matchedDeployMountedInputMode) assert.equal(manifestSha256, expectedManifestSha256, "reused matched-export manifest SHA-256 changed");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.status, "complete", "reused Mobile Web export manifest must be complete");
  assert.equal(manifest.failurePhase, null, "reused Mobile Web export must not have a failure phase");
  assert.equal(manifest.sourceUnchanged, true, "reused Mobile Web source must have stayed stable during its original export");
  assert.equal(manifest.snapshotUnchangedDuringExport, true, "reused Mobile Web build snapshot must have stayed stable during its original export");
  assert.equal(manifest.dependencyProvenance?.sourceUnchanged, true, "reused Mobile Web dependencies must have stayed stable during its original export");
  if (matchedDeployMountedInputMode) assert.equal(manifest.deployMount, true, "reused deploy-mount inputs must come from an export marked deployMount");
  let matchedCommonDependencyProof = null;
  if (matchedDeployMountedInputMode) {
    const dependency = manifest.dependencyProvenance;
    assert.equal(dependency?.sourceTreeSha256Before, MATCHED_COMMON_DEPENDENCY_SOURCE_SHA256, "matched Mobile Web must use the shared pinned dependency input tree");
    assert.equal(dependency?.sourceTreeSha256After, MATCHED_COMMON_DEPENDENCY_SOURCE_SHA256, "shared dependency input tree changed during the original export");
    assert.equal(dependency?.copiedTreeSha256, MATCHED_COMMON_DEPENDENCY_COPY_SHA256, "matched Mobile Web must use the shared pinned owned dependency copy");
    assert.equal(dependency?.copiedFileCount, MATCHED_COMMON_DEPENDENCY_FILE_COUNT, "shared dependency copy file count changed");
    assert.equal(dependency?.copiedSymlinks, false, "shared dependency copy must contain no symlinks");
    matchedCommonDependencyProof = {
      inputTreeSha256: dependency.sourceTreeSha256Before,
      inputStable: dependency.sourceTreeSha256Before === dependency.sourceTreeSha256After && dependency.sourceUnchanged === true,
      ownedCopySha256: dependency.copiedTreeSha256,
      ownedFileCount: dependency.copiedFileCount,
      copiedSymlinks: dependency.copiedSymlinks,
      sourceRoot: dependency.sourceRoot,
    };
  }

  const expectedSourceRoots = [
    { name: "mobile", path: sourceSnapshot.mobileRoot, destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: sourceSnapshot.sharedRoot, destination: "apps/kcoder-studio/shared" },
  ];
  const sourceTree = await hashMobileExportSourceRoots(expectedSourceRoots);
  const expectedMatchedBundleSourceSha256 = snapshotMode === "before" ? MATCHED_BEFORE_SOURCE_TREE_SHA256 : "b22dbddabf802b08a4a586de178c875b576a8279efc51d142a6f1948e40dd020";
  if (matchedDeployMountedInputMode) assert.equal(sourceTree.sha256, expectedMatchedBundleSourceSha256, "matched selected source snapshot differs from its existing source tree digest");
  assert.equal(manifest.sourceTreeSha256, sourceTree.sha256, "reused Mobile Web bundle source digest does not match the selected frozen source snapshot");
  assert.deepEqual(
    manifest.inputRootsAfter?.map(({ name, destination, sha256, fileCount }) => ({ name, destination, sha256, fileCount })),
    sourceTree.roots.map(({ name, destination, sha256, fileCount }) => ({ name, destination, sha256, fileCount })),
    "reused Mobile Web bundle source roots do not match the selected snapshot",
  );
  let matchedPackageLockInputProof = null;
  if (matchedDeployMountedInputMode && snapshotMode === "after") {
    assert.equal(sourceSnapshot.matchedPackageLockSha256, MATCHED_AFTER_PACKAGE_LOCK_SHA256, "Git992 source snapshot lost its pinned package-lock identity");
    const copiedPackageLockSha256 = sha256(await readFile(resolve(sourceSnapshot.mobileRoot, "package-lock.json")));
    assert.equal(copiedPackageLockSha256, MATCHED_AFTER_PACKAGE_LOCK_SHA256, "Git992 source snapshot package-lock bytes changed before reuse validation");
    const originalMobileInput = manifest.inputRootsAfter?.find(root => root.name === "mobile");
    const selectedMobileInput = sourceTree.roots.find(root => root.name === "mobile");
    assert.ok(originalMobileInput && selectedMobileInput, "matched export must retain its original Mobile input-root record");
    assert.deepEqual(
      { destination: originalMobileInput.destination, sha256: originalMobileInput.sha256, fileCount: originalMobileInput.fileCount },
      { destination: selectedMobileInput.destination, sha256: selectedMobileInput.sha256, fileCount: selectedMobileInput.fileCount },
      "the matched export's original Mobile input root must bind the selected Git992 source tree including its pinned package lock",
    );
    matchedPackageLockInputProof = {
      path: "apps/kcoder-studio/mobile/package-lock.json",
      sourceAdapterSha256: sourceSnapshot.matchedPackageLockSha256,
      copiedSourceSha256: copiedPackageLockSha256,
      originalExportMobileInputRootSha256: originalMobileInput.sha256,
      originalExportMobileInputFileCount: originalMobileInput.fileCount,
      originalExportInputRootMatchesSelectedSource: true,
    };
  }

  const actualBundleFiles = await hashBundleTree(bundleRoot);
  if (matchedDeployMountedInputMode) {
    assert.equal(actualBundleFiles.length, resourceCount, "matched deploy-mounted comparison must contain exactly 37 resources");
    assert.equal(manifest.bundleFiles.length, resourceCount, "matched export manifest must name exactly 37 resources");
    assert.equal(manifest.bundleSha256, MATCHED_EXPORT_BUNDLE_SHA256[snapshotMode], "matched deploy-mounted bundle aggregate digest changed");
  }
  assert.deepEqual(actualBundleFiles, manifest.bundleFiles, "reused Mobile Web bundle file list or per-file SHA-256 differs from the complete export manifest");
  assert.equal(sha256(Buffer.from(JSON.stringify(actualBundleFiles))), manifest.bundleSha256, "reused Mobile Web bundle aggregate SHA-256 differs from its manifest");
  assert.ok(actualBundleFiles.some(file => file.path === "index.html" && file.sha256 === manifest.indexHtmlSha256), "reused Mobile Web bundle index.html digest does not match its manifest");

  return {
    path: bundleRoot,
    sourceTreeSha256: manifest.sourceTreeSha256,
    bundleSha256: manifest.bundleSha256,
    bundleManifestPath: manifestPath,
    bundleManifestSha256: manifestSha256,
    reusedManifestPath: manifestPath,
    dependencySourceTreeSha256: manifest.dependencyProvenance?.sourceTreeSha256Before ?? null,
    dependencyOwnedTreeSha256: manifest.dependencyProvenance?.copiedTreeSha256 ?? null,
    reuseValidation: {
      manifestStatus: manifest.status,
      comparisonId: matchedDeployMountedInputMode ? "matched-deploy-mounted-191920" : null,
      sourceTreeMatchesSelectedSnapshot: true,
      sourceRootCount: sourceTree.roots.length,
      bundleFilesMatchManifest: true,
      bundleFileCount: actualBundleFiles.length,
      bundleSha256: manifest.bundleSha256,
      manifestSha256,
      deployMount: manifest.deployMount === true,
      matchedPackageLockInput: matchedPackageLockInputProof,
      matchedCommonDependencyProvenance: matchedCommonDependencyProof,
      bundleFiles: actualBundleFiles,
    },
  };
}

export async function materializeMatchedMobileStaticDist(context, mobileWeb) {
  assert.ok(context && typeof context.pathInState === "function", "a RunContext is required for the matched deploy-mounted dist");
  assert.equal(mobileWeb?.reuseValidation?.deployMount, true, "matched export must be explicitly marked deployMount");
  const expectedFiles = mobileWeb.reuseValidation.bundleFiles;
  assert.ok(Array.isArray(expectedFiles) && expectedFiles.length > 0, "matched deploy-mounted input requires the validated bundle file table");

  const bundleRoot = resolve(mobileWeb.path);
  const bundleInfo = await lstat(bundleRoot);
  assert.ok(bundleInfo.isDirectory() && !bundleInfo.isSymbolicLink(), "matched Mobile Web bundle root must be a regular directory");
  assert.equal(await realpath(bundleRoot), bundleRoot, "matched Mobile Web bundle root must not traverse a symlink");

  const stagingRoot = context.pathInState("matched-mobile-static-dist-source");
  assert.equal(resolve(stagingRoot), stagingRoot, "RunContext returned a non-normalized matched dist staging path");
  const stateRoot = resolve(context.stateDir);
  assert.ok(stagingRoot.startsWith(`${stateRoot}${sep}`), "matched dist staging must remain inside this RunContext state");
  await mkdir(stagingRoot, { recursive: false, mode: 0o700 });
  await chmod(stagingRoot, 0o700);
  context.registerTemporaryDirectory("matched deploy-mounted Mobile dist manifest staging", stagingRoot);

  for (const row of expectedFiles) {
    assert.ok(row && typeof row.path === "string" && Number.isSafeInteger(row.size) && row.size >= 0 && /^[a-f0-9]{64}$/.test(row.sha256), "matched bundle resource row is invalid");
    const segments = row.path.split("/");
    assert.ok(segments.length > 0 && segments.every(segment => segment && segment !== "." && segment !== ".." && !/[\\%?#\x00-\x1f\x7f]/.test(segment)), "matched bundle resource path is unsafe");
    const source = await readMatchedBundleFile(bundleRoot, segments);
    assert.equal(source.bytes.length, row.size, `matched bundle resource size changed before deploy adaptation: ${row.path}`);
    assert.equal(sha256(source.bytes), row.sha256, `matched bundle resource SHA-256 changed before deploy adaptation: ${row.path}`);

    const destination = resolve(stagingRoot, ...segments);
    const relativeDestination = relative(stagingRoot, destination);
    assert.ok(relativeDestination && relativeDestination !== ".." && !relativeDestination.startsWith(`..${sep}`) && !isAbsolute(relativeDestination), "matched dist destination escaped RunContext state");
    let current = stagingRoot;
    for (const segment of segments.slice(0, -1)) {
      current = resolve(current, segment);
      try {
        await mkdir(current, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const directoryInfo = await lstat(current);
      assert.ok(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(), "matched dist staging parent must be a private directory");
      await chmod(current, 0o700);
    }
    await writeFile(destination, source.bytes, { flag: "wx", mode: 0o600 });
    await chmod(destination, 0o600);
  }

  const copiedBundleFiles = await hashBundleTree(stagingRoot);
  assert.deepEqual(copiedBundleFiles, expectedFiles, "matched deploy staging differs from the exact reused bundle file table");
  const manifest = await buildGatewayMobileWebManifest(stagingRoot, { expectedFiles });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = resolve(stagingRoot, "kcoder-mobile-web.json");
  await writeFile(manifestPath, manifestBytes, { flag: "wx", mode: 0o600 });
  await chmod(manifestPath, 0o600);
  const manifestSha256 = sha256(manifestBytes);
  const stagedProof = await inspectOfficialMobileStaticDist({ distRoot: stagingRoot, expectedManifestSha256: manifestSha256 });
  assert.equal(stagedProof.resourceCount, expectedFiles.length, "derived deploy manifest resource count differs from the reused bundle");

  const owned = await copyOfficialMobileStaticDist(context, {
    distRoot: stagingRoot,
    expectedManifestSha256: manifestSha256,
    outputName: "matched-mobile-static-dist",
  });
  assert.equal(owned.ownedCopyVerified, true, "derived deploy-mounted copy must pass the static-dist verifier");
  assert.equal(owned.sourceStableDuringCopy, true, "derived deploy-mounted source must remain stable during copy");
  assert.equal(owned.manifestSha256, manifestSha256, "derived deploy-mounted manifest changed during copy");
  const ownedResourceFiles = owned.resources
    .map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }))
    .sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(ownedResourceFiles, expectedFiles, "derived deploy-mounted resources differ from the matched bundle");

  const evidence = {
    status: "passed",
    inputKind: "matched-export-derived-deploy-mount-manifest",
    note: `The standard Expo bundle and its source were not modified. This one-off adapter generated the existing Gateway static manifest from the exact ${expectedFiles.length}-file matched bundle, then revalidated and copied it into RunContext state.`,
    sourceExportManifestPath: relative(repoRoot, mobileWeb.bundleManifestPath),
    sourceExportManifestSha256: mobileWeb.bundleManifestSha256,
    sourceBundleSha256: mobileWeb.bundleSha256,
    sourceTreeSha256: mobileWeb.sourceTreeSha256,
    derivedManifestPath: relative(context.runRoot, manifestPath),
    derivedManifestSha256: manifestSha256,
    resourceCount: owned.resourceCount,
    resourceTableSha256: owned.resourceTableSha256,
    ownedCopy: {
      root: relative(context.runRoot, owned.ownedRoot),
      verified: owned.ownedCopyVerified,
      stableDuringCopy: owned.sourceStableDuringCopy,
      directoryMode: owned.ownedDirectoryMode,
      fileMode: owned.ownedFileMode,
    },
  };
  await context.writeArtifactJson("matched-deploy-mounted-mobile-dist.json", evidence);
  return { ...owned, inputKind: evidence.inputKind, manifestArtifactPath: manifestPath };
}

async function readMatchedBundleFile(root, segments) {
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const info = await lstat(current);
    assert.equal(info.isSymbolicLink(), false, "matched Mobile Web bundle contains a symlink");
    if (index < segments.length - 1) assert.ok(info.isDirectory(), "matched Mobile Web bundle resource parent is not a directory");
    else assert.ok(info.isFile(), "matched Mobile Web bundle resource is not a regular file");
  }
  assert.equal(await realpath(current), current, "matched Mobile Web bundle resource must not traverse a symlink");
  return { bytes: await readFile(current) };
}

async function hashMobileExportSourceRoots(roots) {
  const hashedRoots = [];
  for (const root of roots) {
    const files = [];
    await appendExportSourceFiles(root.path, "", files);
    files.sort((left, right) => left.path.localeCompare(right.path));
    hashedRoots.push({ name: root.name, destination: root.destination, sha256: sha256(Buffer.from(JSON.stringify(files))), fileCount: files.length });
  }
  return {
    roots: hashedRoots,
    sha256: sha256(Buffer.from(JSON.stringify(hashedRoots.map(({ name, destination, sha256: digest }) => ({ name, destination, sha256: digest }))))),
  };
}

async function appendExportSourceFiles(root, relativeRoot, output) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (exportSourceExcluded(entry.name, entry.isDirectory())) continue;
    const absolute = resolve(root, entry.name);
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const info = await lstat(absolute);
    assert.ok(!info.isSymbolicLink(), `reused export source contains a symlink: ${relativePath}`);
    if (info.isDirectory()) await appendExportSourceFiles(absolute, relativePath, output);
    else if (info.isFile()) {
      const contents = await readFile(absolute);
      output.push({ path: relativePath, size: contents.length, sha256: sha256(contents) });
    }
  }
}

function exportSourceExcluded(name, isDirectory) {
  if (isDirectory && [".expo", ".git", "dist", "node_modules"].includes(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  return /(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name);
}

async function hashBundleTree(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      const info = await lstat(absolute);
      assert.ok(!info.isSymbolicLink(), `reused Mobile Web bundle contains a symlink: ${path}`);
      if (info.isDirectory()) await visit(absolute);
      else if (info.isFile()) {
        const contents = await readFile(absolute);
        files.push({ path, size: contents.length, sha256: sha256(contents) });
      } else {
        assert.fail(`reused Mobile Web bundle contains a non-regular file: ${path}`);
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function copySanitizedTree(sourceRoot, destinationRoot, excludedContent) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const source = resolve(sourceRoot, entry.name);
    const destination = resolve(destinationRoot, entry.name);
    const category = excludedCategory(entry.name, entry.isDirectory());
    if (category) {
      excludedContent[category] = (excludedContent[category] ?? 0) + 1;
      continue;
    }
    const info = await lstat(source);
    assert.ok(!info.isSymbolicLink(), `source tree contains a symlink: ${relative(sourceRoot, source)}`);
    if (info.isDirectory()) {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await copySanitizedTree(source, destination, excludedContent);
    } else if (info.isFile()) {
      await copyFile(source, destination);
    }
  }
}

export async function hashComplement(mobileRoot, sharedRoot) {
  const files = [];
  await appendFileHashes(mobileRoot, "apps/kcoder-studio/mobile", files, new Set(["src"]));
  await appendFileHashes(sharedRoot, "apps/kcoder-studio/shared", files, new Set(["gatewayConnectionBudget.ts"]));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return sha256(Buffer.from(JSON.stringify(files)));
}

async function appendFileHashes(root, repoRelativeRoot, output, excludedNames) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (excludedCategory(entry.name, entry.isDirectory()) || excludedNames.has(entry.name)) continue;
    const absolute = resolve(root, entry.name);
    const repoRelative = `${repoRelativeRoot}/${entry.name}`;
    const info = await lstat(absolute);
    assert.ok(!info.isSymbolicLink(), `complement source contains a symlink: ${repoRelative}`);
    if (info.isDirectory()) await appendFileHashes(absolute, repoRelative, output, new Set());
    else if (info.isFile()) output.push({ path: repoRelative, sha256: sha256(await readFile(absolute)) });
  }
}

async function listFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(relative(root, absolute).split(sep).join("/"));
    }
  }
  await visit(root);
  return output.sort();
}

async function pruneEmptyDirectories(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = resolve(root, entry.name);
    await pruneEmptyDirectories(child);
    if ((await readdir(child)).length === 0) await rmdir(child);
  }
}


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
