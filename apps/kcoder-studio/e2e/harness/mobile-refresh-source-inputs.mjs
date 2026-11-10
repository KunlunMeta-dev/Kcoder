// Original snapshot-inputs mechanisms from the formal refresh/send/background suite.
// Dependencies are the entrypoint's original references; creating helpers starts no resources.
export function createMobileRefreshSourceInputs({
  deviceOnlyMountedAuthMode,
  access, addOfficialMobileExportPostflight, appRoot, assert,
  basename, buildGatewayMobileWebManifest, chmod, copyFile,
  copyOfficialMobileStaticDist, cp, CURRENT_OFFICIAL_DIST_BUILDER_COMMIT, CURRENT_OFFICIAL_DIST_BUILDER_LOG_SHA256,
  CURRENT_OFFICIAL_DIST_DEPENDENCY_LOCK_SHA256, CURRENT_OFFICIAL_DIST_MANIFEST_SHA256, CURRENT_OFFICIAL_DIST_RESOURCE_COUNT, CURRENT_OFFICIAL_DIST_RESOURCE_TABLE_SHA256,
  currentOfficialDistMode, execFileSync, inspectOfficialMobileStaticDist, isAbsolute,
  lstat, MATCHED_AFTER_PACKAGE_LOCK_SHA256, MATCHED_AFTER_SOURCE_ADAPTER, MATCHED_BEFORE_SOURCE_ADAPTER,
  MATCHED_BEFORE_SOURCE_TREE_SHA256, MATCHED_EXPORT_RUN_ROOT, mkdir, officialMobileExportReceiptFromEnv,
  randomBytes, readdir, readFile, readlink,
  readOfficialMobileExportReceipt, realpath, relative, repoRoot,
  resolve, resolveExistingPrivateGatewaySnapshot, resolveExistingPrivatePath, reuseDeployMountedMode,
  reuseExportDirectory, reuseExportManifest, reuseExportManifestSha256, rm,
  rmdir, sep, sha256, snapshotMode,
  stat, waitFor, writeFile,
}) {
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

async function prepareSnapshot(context, mode, currentMobileRoot, currentSharedRoot, snapshotDirectory, expectedSourceDigest, beforeComplementDirectory, beforeComplementSha256, officialPackageLockSha256) {
  const snapshotRoot = resolve(repoRoot, snapshotDirectory || `target/private-phone-latency-implementation/${mode}`);
  assert.ok(snapshotRoot.startsWith(`${repoRoot}${sep}`), "frozen source directory must remain inside the repository target tree");
  const manifestPath = resolve(snapshotRoot, "sha256.json");
  if (reuseDeployMountedMode) {
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
  if (reuseDeployMountedMode && mode === "before") {
    assert.equal(Object.hasOwn(hashes, mobilePackageLockPath), false, "the matched 10feb before adapter intentionally keeps its package lock in the separately verified complement");
  }
  if (reuseDeployMountedMode && mode === "after") {
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
      ? officialPackageLockSha256 ?? CURRENT_OFFICIAL_DIST_DEPENDENCY_LOCK_SHA256
      : reuseDeployMountedMode && mode === "after"
        ? MATCHED_AFTER_PACKAGE_LOCK_SHA256
        : "848076f520f165128b601b27d96d4d32cf25e8929ee54b672f198b9a4c224e26";
    const isPinnedStaticMobilePackageLock = mode === "after"
      && (currentOfficialDistMode || (Boolean(reuseExportDirectory) && Boolean(reuseExportManifest)))
      && path === "apps/kcoder-studio/mobile/package-lock.json"
      && hash === expectedStaticMobilePackageLockSha256;
    assert.ok(!isDependencyLockfile || isPinnedStaticMobilePackageLock, `frozen source may only retain the exact pinned Mobile package-lock as static metadata for after-mode export reuse or current official dist: ${path}`);
    assert.match(hash, /^[a-f0-9]{64}$/, `invalid frozen-source digest for ${path}`);
    if (path === mobilePackageLockPath && reuseDeployMountedMode && mode === "after") matchedPackageLockSha256 = hash;
  }
  let freezeMetadataSha256 = null;
  let frozenSourceDigest = null;
  if (mode === "before" && reuseDeployMountedMode) {
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
    if (reuseDeployMountedMode) {
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
  if (reuseDeployMountedMode && mode === "after") {
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

async function reuseMobileWebExport(context, sourceSnapshot, bundleDirectory, manifestArgument, expectedManifestSha256 = null) {
  let bundleRoot = resolve(repoRoot, bundleDirectory);
  const runArtifactsRoot = resolve(repoRoot, "target/test");
  const privateInputRoot = resolve(repoRoot, "target/private-phone-ux-implementation");
  const matchedExportRunRoot = resolve(repoRoot, MATCHED_EXPORT_RUN_ROOT);
  let manifestPath = resolve(repoRoot, manifestArgument || resolve(bundleRoot, "..", `mobile-web-export-mobile-high-latency-${snapshotMode}-manifest.json`));
  const bundleIsRunArtifact = bundleRoot.startsWith(`${runArtifactsRoot}${sep}`);
  const manifestIsRunArtifact = manifestPath.startsWith(`${runArtifactsRoot}${sep}`);
  const bundleIsPrivateInput = bundleRoot.startsWith(`${privateInputRoot}${sep}`);
  const manifestIsPrivateInput = manifestPath.startsWith(`${privateInputRoot}${sep}`);
  if (reuseDeployMountedMode) {
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
  if (reuseDeployMountedMode) assert.equal(manifestSha256, expectedManifestSha256, "reused matched-export manifest SHA-256 changed");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.status, "complete", "reused Mobile Web export manifest must be complete");
  assert.equal(manifest.failurePhase, null, "reused Mobile Web export must not have a failure phase");
  assert.equal(manifest.sourceUnchanged, true, "reused Mobile Web source must have stayed stable during its original export");
  assert.equal(manifest.snapshotUnchangedDuringExport, true, "reused Mobile Web build snapshot must have stayed stable during its original export");
  assert.equal(manifest.dependencyProvenance?.sourceUnchanged, true, "reused Mobile Web dependencies must have stayed stable during its original export");
  if (reuseDeployMountedMode) assert.equal(manifest.deployMount, true, "reused deploy-mount inputs must come from an export marked deployMount");

  const expectedSourceRoots = [
    { name: "mobile", path: sourceSnapshot.mobileRoot, destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: sourceSnapshot.sharedRoot, destination: "apps/kcoder-studio/shared" },
  ];
  const sourceTree = await hashMobileExportSourceRoots(expectedSourceRoots);
  const expectedMatchedBundleSourceSha256 = snapshotMode === "before" ? MATCHED_BEFORE_SOURCE_TREE_SHA256 : "b22dbddabf802b08a4a586de178c875b576a8279efc51d142a6f1948e40dd020";
  if (reuseDeployMountedMode) assert.equal(sourceTree.sha256, expectedMatchedBundleSourceSha256, "matched selected source snapshot differs from its existing source tree digest");
  assert.equal(manifest.sourceTreeSha256, sourceTree.sha256, "reused Mobile Web bundle source digest does not match the selected frozen source snapshot");
  assert.deepEqual(
    manifest.inputRootsAfter?.map(({ name, destination, sha256, fileCount }) => ({ name, destination, sha256, fileCount })),
    sourceTree.roots.map(({ name, destination, sha256, fileCount }) => ({ name, destination, sha256, fileCount })),
    "reused Mobile Web bundle source roots do not match the selected snapshot",
  );
  let matchedPackageLockInputProof = null;
  if (reuseDeployMountedMode && snapshotMode === "after") {
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
      sourceTreeMatchesSelectedSnapshot: true,
      sourceRootCount: sourceTree.roots.length,
      bundleFilesMatchManifest: true,
      bundleFileCount: actualBundleFiles.length,
      bundleSha256: manifest.bundleSha256,
      manifestSha256,
      deployMount: manifest.deployMount === true,
      matchedPackageLockInput: matchedPackageLockInputProof,
      bundleFiles: actualBundleFiles,
    },
  };
}

async function materializeMatchedMobileStaticDist(context, mobileWeb) {
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

async function prepareGatewayRuntimeSnapshot(context, snapshotDirectoryArgument, binaryOverride, expectedBinarySha256) {
  let snapshotRoot = snapshotDirectoryArgument
    ? resolve(repoRoot, snapshotDirectoryArgument)
    : context.pathInArtifacts("gateway-runtime-frozen");
  const targetTestRoot = resolve(repoRoot, "target/test");
  const privateSnapshotRoot = resolve(repoRoot, "target/private-phone-ux-implementation");
  const isTestArtifactSnapshot = snapshotRoot.startsWith(`${targetTestRoot}${sep}`);
  const isExplicitPrivateSnapshot = Boolean(snapshotDirectoryArgument)
    && snapshotRoot.startsWith(`${privateSnapshotRoot}${sep}`);
  assert.ok(
    isTestArtifactSnapshot || isExplicitPrivateSnapshot,
    "frozen Gateway runtime must be inside target/test or an explicitly selected target/private-phone-ux-implementation snapshot",
  );
  if (isExplicitPrivateSnapshot) {
    const validated = await resolveExistingPrivateGatewaySnapshot(repoRoot, snapshotDirectoryArgument);
    snapshotRoot = validated.snapshotRoot;
  }
  const manifestPath = resolve(snapshotRoot, "gateway-runtime-freeze.json");
  try {
    await access(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.status, "complete", "reused Gateway runtime freeze must be complete");
      const inspected = await inspectGatewayRuntimeSnapshot(snapshotRoot, binaryOverride);
      assert.equal(inspected.sourceDigest, manifest.sourceTreeSha256, "frozen Gateway source tree no longer matches its manifest");
      assert.equal(inspected.dependencyDigest, manifest.dependencyTreeSha256, "frozen Gateway dependency tree no longer matches its manifest");
      assert.equal(inspected.nodeExecutable, manifest.nodeExecutable, "frozen Gateway Node executable path differs from its manifest");
      assert.equal(inspected.nodeVersion, manifest.nodeVersion, "frozen Gateway Node version differs from its manifest");
      if (binaryOverride) {
        assert.deepEqual(
          { nodeExecutable: inspected.runtimeInputs.nodeExecutable, nodeVersion: inspected.runtimeInputs.nodeVersion, nodeStat: inspected.runtimeInputs.nodeStat },
          { nodeExecutable: manifest.runtimeInputs.nodeExecutable, nodeVersion: manifest.runtimeInputs.nodeVersion, nodeStat: manifest.runtimeInputs.nodeStat },
          "frozen Gateway Node executable inputs differ from the freeze manifest",
        );
        assert.equal(inspected.kcoderBinarySha256, expectedBinarySha256, "explicit Gateway KCoder binary does not match its declared SHA-256");
      } else {
        assert.deepEqual(inspected.runtimeInputs, manifest.runtimeInputs, "frozen Gateway runtime executable inputs differ from the freeze manifest");
      }
    return {
      root: snapshotRoot,
      manifestPath,
      manifestSha256: sha256(await readFile(manifestPath)),
      manifest,
      binaryPath: inspected.kcoderBinaryPath,
      binaryOverride: binaryOverride ? { path: inspected.kcoderBinaryPath, sha256: inspected.kcoderBinarySha256 } : null,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    assert.ok(!isExplicitPrivateSnapshot, "an explicitly selected private Gateway runtime must already contain its complete freeze manifest");
  }

  await mkdir(snapshotRoot, { recursive: false, mode: 0o700 });
  const appNodeModules = resolve(appRoot, "node_modules");
  const appNodeModulesReal = await realpath(appNodeModules);
  await assertNoEscapingLinks(appNodeModules, appNodeModulesReal);
  const originBefore = await hashGatewayRuntimeInputs(appRoot);
  const sourceEntries = [];
  for (const name of ["dev-server.mjs", "package.json", "pnpm-lock.yaml"]) {
    const source = resolve(appRoot, name);
    try {
      const info = await lstat(source);
      if (info.isFile()) {
        sourceEntries.push({ source, destination: resolve(snapshotRoot, name) });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const name of ["src", "shared"]) {
    sourceEntries.push({ source: resolve(appRoot, name), destination: resolve(snapshotRoot, name), directory: true });
  }
  for (const entry of sourceEntries) {
    if (entry.directory) {
      await cp(entry.source, entry.destination, { recursive: true, dereference: true, filter: sourceSnapshotFilter });
    } else {
      await cp(entry.source, entry.destination, { dereference: true, filter: sourceSnapshotFilter });
    }
  }
  await cp(appNodeModules, resolve(snapshotRoot, "node_modules"), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: dependencySnapshotFilter,
  });
  const copiedNodeModules = resolve(snapshotRoot, "node_modules");
  await assertNoEscapingLinks(copiedNodeModules, await realpath(copiedNodeModules));

  const inputs = await inspectGatewayRuntimeSnapshot(snapshotRoot);
  const originAfter = await hashGatewayRuntimeInputs(appRoot);
  assert.deepEqual(originAfter, originBefore, "Gateway source or dependencies changed while creating the immutable runtime snapshot");
  assert.equal(inputs.sourceDigest, originBefore.sourceDigest, "copied Gateway source files differ from the stable workspace source");
  assert.equal(inputs.dependencyDigest, originBefore.dependencyDigest, "copied Gateway dependencies differ from the stable workspace dependencies");
  const runtimeInputs = await readGatewayExecutableInputs(binaryOverride);
  if (binaryOverride) assert.equal(runtimeInputs.kcoderBinarySha256, expectedBinarySha256, "explicit Gateway KCoder binary does not match its declared SHA-256");
  const manifest = {
    schemaVersion: 1,
    status: "complete",
    createdAtUtc: new Date().toISOString(),
    sourceRoot: relative(repoRoot, appRoot),
    sourceFiles: inputs.sourceFiles,
    sourceTreeSha256: inputs.sourceDigest,
    workspaceSourceTreeSha256: originBefore.sourceDigest,
    dependencyFiles: inputs.dependencyFiles,
    dependencyTreeSha256: inputs.dependencyDigest,
    workspaceDependencyTreeSha256: originBefore.dependencyDigest,
    dependencySourceRoot: relative(repoRoot, appNodeModulesReal),
    dependencyCopySemantics: "one-time private copy preserving package-manager symlinks with verbatim targets; every dependency symlink is checked to resolve inside the owned node_modules tree; .env/key/credential/cache files are excluded while dependency packages such as dotenv remain",
    runtimeInputs,
    nodeExecutable: inputs.nodeExecutable,
    nodeVersion: inputs.nodeVersion,
    kcoderBinaryPath: inputs.kcoderBinaryPath,
    kcoderBinaryStat: inputs.kcoderBinaryStat,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, bytes, { flag: "wx", mode: 0o600 });
  return {
    root: snapshotRoot,
    manifestPath,
    manifestSha256: sha256(bytes),
    manifest,
    binaryPath: runtimeInputs.kcoderBinaryPath,
    binaryOverride: binaryOverride ? { path: runtimeInputs.kcoderBinaryPath, sha256: runtimeInputs.kcoderBinarySha256 } : null,
  };
}

async function inspectGatewayRuntimeSnapshot(snapshotRoot, binaryOverride = null) {
  const sourceFiles = [];
  const dependencyFiles = [];
  await appendGatewaySnapshotFiles(snapshotRoot, "", sourceFiles, false);
  await appendGatewaySnapshotFiles(resolve(snapshotRoot, "node_modules"), "", dependencyFiles, true);
  sourceFiles.sort((left, right) => left.path.localeCompare(right.path));
  dependencyFiles.sort((left, right) => left.path.localeCompare(right.path));
  const nodeExecutable = await realpath(process.execPath);
  const nodeVersion = process.version;
  const kcoderBinaryPath = binaryOverride || process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
  const kcoderBinaryStat = await regularFileIdentity(kcoderBinaryPath);
  const runtimeInputs = await readGatewayExecutableInputs(binaryOverride);
  return {
    sourceFiles,
    sourceDigest: sha256(Buffer.from(JSON.stringify(sourceFiles))),
    dependencyFiles,
    dependencyDigest: sha256(Buffer.from(JSON.stringify(dependencyFiles))),
    nodeExecutable,
    nodeVersion,
    kcoderBinaryPath: kcoderBinaryStat ? await realpath(kcoderBinaryPath) : resolve(kcoderBinaryPath),
    kcoderBinaryStat,
    kcoderBinarySha256: runtimeInputs.kcoderBinarySha256,
    runtimeInputs,
  };
}

async function hashGatewayRuntimeInputs(root) {
  const sourceFiles = [];
  for (const name of ["dev-server.mjs", "package.json", "pnpm-lock.yaml"]) {
    const path = resolve(root, name);
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      sourceFiles.push({ path: name, size: info.size, sha256: sha256(await readFile(path)) });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const name of ["src", "shared"]) await appendGatewaySnapshotFiles(resolve(root, name), name, sourceFiles, false);
  const dependencyFiles = [];
  await appendGatewaySnapshotFiles(resolve(root, "node_modules"), "", dependencyFiles, true);
  sourceFiles.sort((left, right) => left.path.localeCompare(right.path));
  dependencyFiles.sort((left, right) => left.path.localeCompare(right.path));
  return {
    sourceFiles,
    sourceDigest: sha256(Buffer.from(JSON.stringify(sourceFiles))),
    dependencyFiles,
    dependencyDigest: sha256(Buffer.from(JSON.stringify(dependencyFiles))),
  };
}

async function appendGatewaySnapshotFiles(root, relativeRoot, output, dependencies) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "gateway-runtime-freeze.json") continue;
    if (!dependencies && entry.name === "node_modules") continue;
    if (dependencies && dependencySnapshotExcluded(entry.name, entry.isDirectory())) continue;
    if (!dependencies && sourceSnapshotExcluded(entry.name, entry.isDirectory())) continue;
    const absolute = resolve(root, entry.name);
    const path = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    let info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      assert.ok(dependencies, `frozen Gateway source snapshot contains a symlink: ${path}`);
      output.push({ path, symlinkTarget: await readlink(absolute) });
      info = await stat(absolute);
    }
    if (info.isDirectory()) await appendGatewaySnapshotFiles(absolute, path, output, dependencies);
    else if (info.isFile()) {
      const contents = await readFile(absolute);
      output.push({ path, size: contents.length, sha256: sha256(contents) });
    }
  }
}

function sourceSnapshotFilter(sourcePath) {
  const name = basename(sourcePath);
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return false;
  return !/\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

function dependencySnapshotFilter(sourcePath) {
  const name = basename(sourcePath);
  return !dependencySnapshotExcluded(name, false) && !dependencySnapshotExcluded(name, true);
}

function dependencySnapshotExcluded(name, isDirectory) {
  if (isDirectory && [".vite", ".cache", "coverage", ".git"].includes(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  if ([".npmrc", "credentials.json", "account_credentials.json"].includes(name)) return true;
  if (/(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name)) return true;
  return /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

function sourceSnapshotExcluded(name, isDirectory) {
  if (isDirectory && [".git", ".expo", "dist", "target"].includes(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  return /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

async function assertNoEscapingLinks(root, allowedRoot) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      assert.ok(target === allowedRoot || target.startsWith(`${allowedRoot}${sep}`), `Gateway dependency symlink escapes its package root: ${relative(root, path)}`);
    } else if (info.isDirectory()) {
      await assertNoEscapingLinks(path, allowedRoot);
    }
  }
}

async function readGatewayExecutableInputs(binaryOverride = null) {
  const nodeExecutable = await realpath(process.execPath);
  const nodeStat = await regularFileIdentity(nodeExecutable);
  const kcoderBinaryPath = binaryOverride || process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
  const kcoderBinaryStat = await regularFileIdentity(kcoderBinaryPath);
  return {
    nodeExecutable,
    nodeVersion: process.version,
    nodeStat,
    kcoderBinaryPath: kcoderBinaryStat ? await realpath(kcoderBinaryPath) : resolve(kcoderBinaryPath),
    kcoderBinaryStat,
    kcoderBinarySha256: kcoderBinaryStat ? sha256(await readFile(kcoderBinaryPath)) : null,
  };
}

async function regularFileIdentity(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return { size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function gatewayRuntimeStable(before, after) {
  return before.sourceDigest === after.sourceDigest
    && before.dependencyDigest === after.dependencyDigest
    && before.nodeExecutable === after.nodeExecutable
    && before.nodeVersion === after.nodeVersion
    && before.kcoderBinaryPath === after.kcoderBinaryPath
    && JSON.stringify(before.kcoderBinaryStat) === JSON.stringify(after.kcoderBinaryStat)
    && JSON.stringify(before.runtimeInputs) === JSON.stringify(after.runtimeInputs);
}

async function loadCurrentOfficialMobileDist(context) {
  const receiptInput = officialMobileExportReceiptFromEnv();
  const standard = ["DIST_ROOT", "MANIFEST_SHA256", "BUILDER_COMMIT", "BUILD_LOG_PATH", "BUILD_LOG_SHA256"]
    .map(name => process.env[`KCODER_E2E_STANDARD_MOBILE_${name}`]);
  if (standard.some(value => value !== undefined)) {
    assert.equal(receiptInput, null, "standard build and official export receipt inputs cannot be mixed");
    assert.ok(!reuseDeployMountedMode && !process.argv.includes("--reuse-matched-deploy-mounted-formal") && !reuseExportDirectory && !reuseExportManifest && !reuseExportManifestSha256, "standard build cannot mix export reuse inputs");
    assert.ok(standard.every(value => typeof value === "string" && value.length > 0), "standard build requires all five explicit input pins");
    const [distRoot, manifestSha256, builderCommit, buildLogPath, buildLogSha256] = standard;
    for (const value of [manifestSha256, buildLogSha256]) assert.match(value, /^[a-f0-9]{64}$/);
    assert.match(builderCommit, /^[a-f0-9]{40}$/, "standard builder commit must be an exact Git commit");
    for (const path of [distRoot, buildLogPath]) {
      assert.ok(isAbsolute(path) && resolve(path) === path && path.startsWith(`${resolve(repoRoot, "target")}${sep}`), "standard build inputs must use canonical owned target paths");
      assert.equal(await realpath(path), path, "standard build input must not traverse symlinks");
    }
    assert.ok((await lstat(buildLogPath)).isFile(), "standard build log must be regular");
    const verify = async () => {
      const log = await readFile(buildLogPath);
      assert.equal(sha256(log), buildLogSha256, "standard build log changed");
      assert.ok(log.toString("utf8").split(/\r?\n/).includes(`head=${builderCommit}`), "standard build log must bind its builder commit");
      assert.match(log.toString("utf8"), /(?:^|\n)build_exit_code=0\r?\n?$/, "standard build did not exit successfully");
      const parity = verifyCurrentOfficialMobileBuilderSourceParity(builderCommit);
      const source = await inspectOfficialMobileStaticDist({ distRoot, expectedManifestSha256: manifestSha256 });
      assert.equal(source.resourceCount, CURRENT_OFFICIAL_DIST_RESOURCE_COUNT);
      return { parity, source };
    };
    const before = await verify();
    context.addCleanup("verify standard Mobile build inputs after run", async () => {
      const after = await verify();
      assert.equal(after.source.resourceTableSha256, before.source.resourceTableSha256);
    });
    const owned = await copyOfficialMobileStaticDist(context, { distRoot, expectedManifestSha256: manifestSha256, outputName: "current-official-mobile-static-dist" });
    assert.equal(owned.ownedCopyVerified, true); assert.equal(owned.sourceStableDuringCopy, true);
    assert.equal(owned.resourceTableSha256, before.source.resourceTableSha256);
    const sourcePackageLockSha256 = sha256(execFileSync("git", ["show", `${builderCommit}:apps/kcoder-studio/mobile/package-lock.json`], { cwd: repoRoot }));
    return { ...owned, builderCommit, builderLogSha256: buildLogSha256, builderSourceParity: before.parity,
      sourcePackageLockSha256, standardBuild: { buildLogPath, buildLogSha256, manifestSha256, exitCode: 0 } };
  }
  if (receiptInput) {
    const input = await readOfficialMobileExportReceipt(receiptInput);
    addOfficialMobileExportPostflight(context, receiptInput, input);
    const owned = await copyOfficialMobileStaticDist(context, {
      distRoot: input.distRoot, expectedManifestSha256: input.manifestSha256,
      outputName: "current-official-mobile-static-dist",
    });
    assert.equal(owned.resourceTableSha256, input.sourceDist.resourceTableSha256);
    return { ...owned, builderCommit: input.builderCommit, builderLogSha256: null,
      builderSourceParity: input.builderSourceParity,
      sourcePackageLockSha256: input.receipt.source.packageLockSha256,
      exportReceipt: { path: input.receiptPath, sha256: input.receiptSha256, runManifestSha256: input.runManifestSha256 },
    };
  }
  const targetRoot = resolve(repoRoot, "..");
  const distRoot = resolve(repoRoot, "target/worktree/2026/10/09/mobile-ux-all-changes-20261009/apps/kcoder-studio/mobile/dist");
  const builderRunRoot = resolve(targetRoot, "private-phone-ux-implementation/mobile-combined-validation-f2b0df88-20261009-01");
  const builderLog = await readFile(resolve(builderRunRoot, "gateway-web-export.stdout"));
  assert.equal(sha256(builderLog), CURRENT_OFFICIAL_DIST_BUILDER_LOG_SHA256, "current official Mobile dist builder log changed");
  assert.equal((await readFile(resolve(builderRunRoot, "gateway-web-export.exit"), "utf8")).trim(), "0", "current official Mobile dist builder did not exit successfully");
  const builderSourceParity = verifyCurrentOfficialMobileBuilderSourceParity();
  const source = await inspectOfficialMobileStaticDist({
    distRoot,
    expectedManifestSha256: CURRENT_OFFICIAL_DIST_MANIFEST_SHA256,
  });
  assert.equal(source.resourceCount, CURRENT_OFFICIAL_DIST_RESOURCE_COUNT);
  assert.equal(source.resourceTableSha256, CURRENT_OFFICIAL_DIST_RESOURCE_TABLE_SHA256);
  const owned = await copyOfficialMobileStaticDist(context, {
    distRoot,
    expectedManifestSha256: CURRENT_OFFICIAL_DIST_MANIFEST_SHA256,
    outputName: "current-official-mobile-static-dist",
  });
  assert.equal(owned.ownedCopyVerified, true);
  assert.equal(owned.sourceStableDuringCopy, true);
  assert.equal(owned.resourceTableSha256, CURRENT_OFFICIAL_DIST_RESOURCE_TABLE_SHA256);
  return {
    ...owned,
    builderCommit: CURRENT_OFFICIAL_DIST_BUILDER_COMMIT,
    builderLogSha256: CURRENT_OFFICIAL_DIST_BUILDER_LOG_SHA256,
    builderSourceParity,
  };
}

function verifyCurrentOfficialMobileBuilderSourceParity(builderCommit = CURRENT_OFFICIAL_DIST_BUILDER_COMMIT) {
  const currentHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const sourcePaths = ["apps/kcoder-studio/mobile", "apps/kcoder-studio/shared"];
  execFileSync("git", ["diff", "--quiet", builderCommit, currentHead, "--", ...sourcePaths], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["diff", "--quiet", "HEAD", "--", ...sourcePaths], { cwd: repoRoot, stdio: "ignore" });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...sourcePaths], { cwd: repoRoot, encoding: "utf8" }).trim();
  assert.equal(untracked, "", "Mobile/Shared has untracked source outside the official builder scope");
  return { builderCommit, currentHead, comparedPaths: sourcePaths, commitTreeEqual: true, worktreeTrackedClean: true, untrackedSources: 0 };
}

function mobileEntryUrl(gateway) {
  return deviceOnlyMountedAuthMode ? new URL("/mobile/", gateway.baseUrl).toString() : gateway.baseUrl;
}

async function navigateToMobileEntry(page, gateway, options) {
  const target = mobileEntryUrl(gateway);
  const response = await page.goto(target, options);
  if (deviceOnlyMountedAuthMode) {
    assert.equal(response?.status(), 200, "mounted Mobile Web handler must serve the matched /mobile/ entry");
    assert.equal(new URL(target).pathname, "/mobile/", "mounted smoke target must be the Gateway /mobile/ route");
    assert.equal(new URL(response.url()).pathname, "/mobile/", "Gateway response must come from the mounted /mobile/ route");
    assert.equal(new URL(page.url()).pathname, "/mobile/", "the browser must remain on the mounted /mobile/ route");
  }
  return response;
}

async function startFrozenGateway(context, gatewayRuntime, { label, workspace, serversFile, serversStore, webRoot, mobileWebRoot, mock }) {
  const host = "127.0.0.1";
  const port = 0;
  const authToken = randomBytes(24).toString("base64url");
  context.registerSecret(authToken);
  const overrides = {
    KCODER_STUDIO_HOST: host,
    KCODER_STUDIO_PORT: String(port),
    KCODER_STUDIO_KCODER_BIN: gatewayRuntime.binaryPath || gatewayRuntime.manifest.runtimeInputs.kcoderBinaryPath,
    KCODER_STUDIO_WORKSPACE: workspace,
    KCODER_STUDIO_WEB_ROOT: webRoot,
    ...(mobileWebRoot ? { KCODER_STUDIO_MOBILE_WEB_ROOT: mobileWebRoot } : {}),
    KCODER_STUDIO_SERVERS_FILE: serversFile,
    KCODER_STUDIO_SERVERS_STORE: serversStore,
    KCODER_STUDIO_AUTH_TOKEN: authToken,
    KCODER_STUDIO_ALLOWED_HOSTS: "127.0.0.1,localhost,::1",
    KCODER_STUDIO_MOCK: mock ? "1" : "0",
  };
  const env = context.isolatedEnvironment(overrides);
  const scriptPath = resolve(gatewayRuntime.root, "dev-server.mjs");
  const child = context.spawnOwned(label, process.execPath, [scriptPath], {
    cwd: gatewayRuntime.root,
    env,
  });
  const logPath = resolve(context.logsDir, `${label}.log`);
  const gatewayPort = await waitFor(async () => {
    const log = await readFile(logPath, "utf8").catch(() => "");
    const match = log.match(/KCoder Studio: http:\/\/[^:]+:(\d+)/);
    if (child.exitCode !== null) throw new Error(`frozen Gateway exited with code ${child.exitCode}; inspect ${logPath}`);
    return match ? Number(match[1]) : null;
  }, 15_000, "frozen isolated Gateway startup", 50, context.abortSignal);
  context.registerPort(label, gatewayPort);
  return {
    child,
    port: gatewayPort,
    host,
    serversStore,
    baseUrl: `http://${host}:${gatewayPort}`,
    wsUrl: `ws://${host}:${gatewayPort}`,
    authToken,
    logPath,
    scriptPath,
    cwd: gatewayRuntime.root,
  };
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

async function createDependencySnapshot(context, currentMobileRoot) {
  const sourceRoot = resolve(currentMobileRoot, "node_modules");
  const snapshotRoot = context.pathInState("mobile-dependency-input-frozen");
  await mkdir(snapshotRoot, { recursive: false, mode: 0o700 });
  context.registerTemporaryDirectory("isolated Mobile dependency input snapshot", snapshotRoot);
  const label = "phone-ux-dependency-snapshot-copy";
  const copyStartedAtUtc = new Date().toISOString();
  const child = context.spawnOwned(label, "cp", ["-aL", "--reflink=auto", `${sourceRoot}/.`, `${snapshotRoot}/`], {
    cwd: repoRoot,
    env: context.isolatedEnvironment(),
  });
  let spawnError = null;
  child.once("error", error => { spawnError = error; });
  try {
    await waitFor(
      () => spawnError || child.exitCode !== null || child.signalCode !== null,
      10 * 60_000,
      "isolated Mobile dependency input snapshot copy",
      100,
      context.abortSignal,
    );
    if (spawnError) throw new Error(`dependency snapshot copy could not start: ${spawnError.message}`);
    assert.equal(child.exitCode, 0, `dependency snapshot copy exited with ${child.signalCode || `code ${child.exitCode}`}`);
  } finally {
    await context.stopOwned(label);
  }
  const excludedContentCounts = Object.create(null);
  await removeDependencyCacheAndSecretFiles(snapshotRoot, excludedContentCounts);
  return {
    path: snapshotRoot,
    sourceRoot,
    copyPid: child.pid,
    copyStartedAtUtc,
    copyCompletedAtUtc: new Date().toISOString(),
    excludedContentCounts,
    semantics: "private dependency copy; generated .vite cache, dotenv files, credentials, and key material removed before the exporter hashes or builds it",
  };
}

async function removeDependencyCacheAndSecretFiles(root, counts) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    const category = dependencyExcludedCategory(entry.name, entry.isDirectory());
    if (category) {
      counts[category] = (counts[category] ?? 0) + 1;
      await rm(path, { recursive: true, force: true });
      continue;
    }
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink(), "isolated Mobile dependency snapshot must not contain symlinks");
    if (info.isDirectory()) await removeDependencyCacheAndSecretFiles(path, counts);
  }
}

function dependencyExcludedCategory(name, isDirectory) {
  if (isDirectory && name === ".vite") return "generated-vite-cache-directory";
  if (name === ".env" || /^\.env\.(?!example(?:\.|$))/i.test(name)) return "environment-file";
  if ([".npmrc", "credentials.json", "account_credentials.json"].includes(name)) return "credential-file";
  if (/(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name)) return "credential-named-file";
  if (/\.(?:pem|key|p12|pfx|keystore)$/i.test(name)) return "cryptographic-key-material";
  return null;
}

async function copyArtifactTree(sourceRoot, destinationRoot) {
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const source = resolve(sourceRoot, entry.name);
    const destination = resolve(destinationRoot, entry.name);
    const info = await lstat(source);
    assert.ok(!info.isSymbolicLink(), "exported Mobile Web bundle must not contain symlinks");
    if (info.isDirectory()) await copyArtifactTree(source, destination);
    else if (info.isFile()) await copyFile(source, destination);
  }
}

function excludedCategory(name, isDirectory) {
  if (isDirectory && ["node_modules", ".expo", ".git", "dist", "target"].includes(name)) return "generated-or-dependency-directory";
  if (name === ".env" || /^\.env\.(?!example(?:\.|$))/i.test(name)) return "environment-file";
  if ([".npmrc", "credentials.json", "account_credentials.json"].includes(name)) return "credential-file";
  if (/\.(?:pem|key|p12|pfx|keystore)$/i.test(name)) return "cryptographic-key-material";
  return null;
}

async function hashComplement(mobileRoot, sharedRoot) {
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

  return {
  resolvePrivateBeforeComplementRoot, prepareSnapshot, reuseMobileWebExport, materializeMatchedMobileStaticDist,
  readMatchedBundleFile, hashMobileExportSourceRoots, appendExportSourceFiles, exportSourceExcluded,
  hashBundleTree, prepareGatewayRuntimeSnapshot, inspectGatewayRuntimeSnapshot, hashGatewayRuntimeInputs,
  appendGatewaySnapshotFiles, sourceSnapshotFilter, dependencySnapshotFilter, dependencySnapshotExcluded,
  sourceSnapshotExcluded, assertNoEscapingLinks, readGatewayExecutableInputs, regularFileIdentity,
  gatewayRuntimeStable, loadCurrentOfficialMobileDist, verifyCurrentOfficialMobileBuilderSourceParity, mobileEntryUrl,
  navigateToMobileEntry, startFrozenGateway, copySanitizedTree, createDependencySnapshot,
  removeDependencyCacheAndSecretFiles, dependencyExcludedCategory, copyArtifactTree, excludedCategory,
  hashComplement, appendFileHashes, listFiles, pruneEmptyDirectories,
  };
}
