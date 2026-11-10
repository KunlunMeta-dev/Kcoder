// Private historical refresh mechanisms. Factory creation starts no resources.
export function createPrivateRefreshSourceInputs({
  access,
  appRoot,
  assert,
  basename,
  copyFile,
  cp,
  lstat,
  mkdir,
  randomBytes,
  readFile,
  readdir,
  readlink,
  realpath,
  relative,
  repoRoot,
  resolve,
  resolveExistingPrivateGatewaySnapshot,
  resolveExistingPrivatePath,
  reuseExportDirectory,
  reuseExportManifest,
  rm,
  rmdir,
  sep,
  sha256,
  snapshotMode,
  stat,
  waitFor,
  writeFile,
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

async function prepareSnapshot(context, mode, currentMobileRoot, currentSharedRoot, snapshotDirectory, expectedSourceDigest, beforeComplementDirectory, beforeComplementSha256) {
  const snapshotRoot = resolve(repoRoot, snapshotDirectory || `target/private-phone-latency-implementation/${mode}`);
  assert.ok(snapshotRoot.startsWith(`${repoRoot}${sep}`), "frozen source directory must remain inside the repository target tree");
  const manifestPath = resolve(snapshotRoot, "sha256.json");
  await access(manifestPath);
  const manifestBytes = await readFile(manifestPath);
  const hashes = JSON.parse(manifestBytes.toString("utf8"));
  assert.ok(hashes && typeof hashes === "object" && !Array.isArray(hashes), "frozen source manifest must map repository-relative paths to SHA-256 values");
  const entries = Object.entries(hashes);
  assert.ok(entries.length > 0, "frozen source manifest is empty");
  for (const [path, hash] of entries) {
    const validBeforePath = path.startsWith("apps/kcoder-studio/mobile/") || path.startsWith("apps/kcoder-studio/shared/");
    const validAfterPath = path.startsWith("apps/kcoder-studio/") || path.startsWith("apps/kcoder-relay/");
    assert.ok(mode === "before" ? validBeforePath : validAfterPath, `unexpected frozen-source path: ${path}`);
    const pathSegments = path.split("/");
    assert.equal(pathSegments.includes("node_modules"), false, `frozen source must not include dependencies: ${path}`);
    assert.equal(pathSegments.some(segment => segment.startsWith(".env")), false, `frozen source must not include dotenv credentials: ${path}`);
    const isDependencyLockfile = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path);
    const isPinnedStaticMobilePackageLock = mode === "after"
      && Boolean(reuseExportDirectory)
      && Boolean(reuseExportManifest)
      && path === "apps/kcoder-studio/mobile/package-lock.json"
      && hash === "848076f520f165128b601b27d96d4d32cf25e8929ee54b672f198b9a4c224e26";
    assert.ok(!isDependencyLockfile || isPinnedStaticMobilePackageLock, `frozen source may only retain the exact pinned Mobile package-lock as static metadata for after-mode reuse-export: ${path}`);
    assert.match(hash, /^[a-f0-9]{64}$/, `invalid frozen-source digest for ${path}`);
  }
  let freezeMetadataSha256 = null;
  let frozenSourceDigest = null;
  if (mode === "after") {
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
    const sourceBytes = await readFile(source);
    const actualHash = sha256(sourceBytes);
    assert.equal(actualHash, expectedHash, `frozen before/after source hash mismatch for ${path}`);
    await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    overlay.push({ path, sha256: actualHash });
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
    overlaySha256: sha256(Buffer.from(JSON.stringify(overlay))),
    complementSha256: complementShaAfterOverlay,
    complementSource,
    completeness,
    excludedContentCounts: excludedContent,
  };
}

async function reuseMobileWebExport(context, sourceSnapshot, bundleDirectory, manifestArgument) {
  let bundleRoot = resolve(repoRoot, bundleDirectory);
  const runArtifactsRoot = resolve(repoRoot, "target/test");
  const privateInputRoot = resolve(repoRoot, "target/private-phone-ux-implementation");
  let manifestPath = resolve(repoRoot, manifestArgument || resolve(bundleRoot, "..", `mobile-web-export-mobile-high-latency-${snapshotMode}-manifest.json`));
  const bundleIsRunArtifact = bundleRoot.startsWith(`${runArtifactsRoot}${sep}`);
  const manifestIsRunArtifact = manifestPath.startsWith(`${runArtifactsRoot}${sep}`);
  const bundleIsPrivateInput = bundleRoot.startsWith(`${privateInputRoot}${sep}`);
  const manifestIsPrivateInput = manifestPath.startsWith(`${privateInputRoot}${sep}`);
  if (bundleIsRunArtifact && manifestIsRunArtifact) {
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
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.status, "complete", "reused Mobile Web export manifest must be complete");
  assert.equal(manifest.failurePhase, null, "reused Mobile Web export must not have a failure phase");
  assert.equal(manifest.sourceUnchanged, true, "reused Mobile Web source must have stayed stable during its original export");
  assert.equal(manifest.snapshotUnchangedDuringExport, true, "reused Mobile Web build snapshot must have stayed stable during its original export");
  assert.equal(manifest.dependencyProvenance?.sourceUnchanged, true, "reused Mobile Web dependencies must have stayed stable during its original export");

  const expectedSourceRoots = [
    { name: "mobile", path: sourceSnapshot.mobileRoot, destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: sourceSnapshot.sharedRoot, destination: "apps/kcoder-studio/shared" },
  ];
  const sourceTree = await hashMobileExportSourceRoots(expectedSourceRoots);
  assert.equal(manifest.sourceTreeSha256, sourceTree.sha256, "reused Mobile Web bundle source digest does not match the selected frozen source snapshot");
  assert.deepEqual(
    manifest.inputRootsAfter?.map(({ name, destination, sha256, fileCount }) => ({ name, destination, sha256, fileCount })),
    sourceTree.roots.map(({ name, destination, sha256, fileCount }) => ({ name, destination, sha256, fileCount })),
    "reused Mobile Web bundle source roots do not match the selected snapshot",
  );

  const actualBundleFiles = await hashBundleTree(bundleRoot);
  assert.deepEqual(actualBundleFiles, manifest.bundleFiles, "reused Mobile Web bundle file list or per-file SHA-256 differs from the complete export manifest");
  assert.equal(sha256(Buffer.from(JSON.stringify(actualBundleFiles))), manifest.bundleSha256, "reused Mobile Web bundle aggregate SHA-256 differs from its manifest");
  assert.ok(actualBundleFiles.some(file => file.path === "index.html" && file.sha256 === manifest.indexHtmlSha256), "reused Mobile Web bundle index.html digest does not match its manifest");

  return {
    path: bundleRoot,
    sourceTreeSha256: manifest.sourceTreeSha256,
    bundleSha256: manifest.bundleSha256,
    bundleManifestPath: manifestPath,
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
    },
  };
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

async function startFrozenGateway(context, gatewayRuntime, { label, workspace, serversFile, serversStore, webRoot, mock }) {
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

return { resolvePrivateBeforeComplementRoot, prepareSnapshot, reuseMobileWebExport, hashMobileExportSourceRoots, appendExportSourceFiles, exportSourceExcluded, hashBundleTree, prepareGatewayRuntimeSnapshot, inspectGatewayRuntimeSnapshot, hashGatewayRuntimeInputs, appendGatewaySnapshotFiles, sourceSnapshotFilter, dependencySnapshotFilter, dependencySnapshotExcluded, sourceSnapshotExcluded, assertNoEscapingLinks, readGatewayExecutableInputs, regularFileIdentity, gatewayRuntimeStable, startFrozenGateway, copySanitizedTree, createDependencySnapshot, removeDependencyCacheAndSecretFiles, dependencyExcludedCategory, copyArtifactTree, excludedCategory, hashComplement, appendFileHashes, listFiles, pruneEmptyDirectories };
}
