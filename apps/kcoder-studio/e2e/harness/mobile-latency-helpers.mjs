import { access, chmod, cp, copyFile, lstat, mkdir, readFile, readlink, readdir, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { appRoot, repoRoot, runE2E, waitFor } from "./run-context.mjs";
import { basename, relative, resolve, sep } from "node:path";
import assert from "node:assert/strict";
import { resolveExistingPrivateGatewaySnapshot, resolveExistingPrivatePath } from "./gateway-runtime-snapshot-guard.mjs";
import { createHash, randomBytes } from "node:crypto";
import { createAcceptedTurnReceiptFixture, createResponseJitter, mobileApiPath, sanitizeGatewayPath, sumResponseDelayMs } from "./mobile-high-latency-fault-fixture.mjs";
import { performance } from "node:perf_hooks";

/** Shared suite helpers; the caller retains resource attribution and configuration. */
export function createMobileLatencyHelpers({
  sha256,
  snapshotMode,
  reuseExportDirectory,
  reuseExportManifest,
  round,
  epochNow,
  THREAD_ID,
  SERVER_ID,
  safePath,
  delay,
  drawerCloseDiagnosticsEnabled,
  sampleCount,
  DEFAULT_SAMPLES,
  percentile,
  APPLICATION_DELAY_TIMER_TOLERANCE_MS,
  suiteUrl,
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

async function connectMobile(page, gateway, { beforeFixtureSessionVisible } = {}) {
  const loginResponse = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  page.__phoneUxLastNavigationStatus = loginResponse?.status() ?? null;
  assert.equal(loginResponse?.status(), 200, "isolated test Gateway should serve Mobile Web");
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 60_000 });
  if (beforeFixtureSessionVisible) await beforeFixtureSessionVisible();
  await ensureFixtureSessionVisible(page);
}

async function collectPreShimNativeWebSocketEvidence(page, network) {
  const evidence = await page.evaluate(() => window.__phoneUxDrainApplicationWebSocketEvidence?.() ?? null);
  if (!evidence) return null;
  network.applicationWebSocketCaptureHealth.push({
    captureLayer: "pre-playwright-WebSocketMock native transport; upstream observation only, not app dispatch/receipt",
    pageId: evidence.pageId,
    socketsCapturedThisDrain: evidence.sockets.length,
    framesCapturedThisDrain: evidence.frames.length,
    socketOverflowCount: evidence.socketOverflowCount,
    frameOverflowCount: evidence.frameOverflowCount,
    storageWriteFailureCount: evidence.storageWriteFailureCount,
    maxSocketsPerPage: evidence.maxSocketsPerPage,
    maxFramesPerPage: evidence.maxFramesPerPage,
    drainedAtEpochMs: round(epochNow()),
  });
  const socketKeys = new Set(network.applicationWebSocketConnections.map(row => `${row.pageId}:${row.socketId}`));
  for (const row of evidence.sockets) {
    const key = `${row.pageId}:${row.socketId}`;
    if (!socketKeys.has(key)) {
      network.applicationWebSocketConnections.push(row);
      socketKeys.add(key);
    }
  }
  const frameKeys = new Set(network.applicationWebSocketFrames.map(row => `${row.pageId}:${row.socketId}:${row.direction}:${row.atEpochMs}:${row.rpcIdFingerprint ?? "-"}:${row.method ?? "-"}`));
  for (const row of evidence.frames) {
    const key = `${row.pageId}:${row.socketId}:${row.direction}:${row.atEpochMs}:${row.rpcIdFingerprint ?? "-"}:${row.method ?? "-"}`;
    if (!frameKeys.has(key)) {
      network.applicationWebSocketFrames.push(row);
      frameKeys.add(key);
    }
  }
  return { pageId: evidence.pageId, socketsCapturedThisDrain: evidence.sockets.length, framesCapturedThisDrain: evidence.frames.length };
}

async function ensureFixtureSessionVisible(page) {
  const thread = page.getByTestId(`thread-${THREAD_ID}`);
  if (await thread.isVisible().catch(() => false)) return;
  const serverToggle = page.getByTestId(`toggle-server-${SERVER_ID}`);
  await serverToggle.waitFor({ state: "visible", timeout: 30_000 });
  if ((await serverToggle.getAttribute("aria-expanded")) !== "true") await serverToggle.click();
  await thread.waitFor({ state: "visible", timeout: 30_000 });
}

async function describeVisiblePage(page) {
  const urlPath = safePath(page.url());
  const routeClass = await page.evaluate(() => {
    const path = globalThis.location?.pathname ?? "";
    if (path.startsWith("/welcome")) return "welcome";
    if (path.includes("/task/")) return "task";
    if (path.startsWith("/settings")) return "settings";
    if (path === "/" || path.includes("/h/")) return "home";
    return "other";
  }).catch(() => "unavailable");
  const visible = {};
  for (const [name, selector] of Object.entries({
    welcomeDirectConnection: "welcome-direct-connection",
    welcomePairingLink: "welcome-paste-pairing-link",
    newWorkspace: "new-workspace",
    serverStatusRefreshing: "server-status-refreshing",
    serverStatusError: "server-status-error",
    reauthorizeActiveProfile: "reauthorize-active-profile",
    fixtureServerToggle: `toggle-server-${SERVER_ID}`,
    fixtureThread: `thread-${THREAD_ID}`,
    taskHeader: "task-header-title",
    messageInput: "message-input-root",
  })) visible[name] = await page.getByTestId(selector).isVisible().catch(() => false);
  visible.gatewayLoginToken = await page.locator('input[name="token"]').isVisible().catch(() => false);
  visible.gatewayLoginSubmit = await page.locator('form[action="/login"] button[type="submit"]').isVisible().catch(() => false);
  visible.gatewayEndpoint = await page.getByTestId("gateway-endpoint").isVisible().catch(() => false);
  visible.gatewayToken = await page.getByTestId("gateway-token").isVisible().catch(() => false);
  visible.gatewayConnect = await page.getByTestId("gateway-connect").isVisible().catch(() => false);
  return {
    urlPath,
    lastNavigationStatus: Number.isInteger(page.__phoneUxLastNavigationStatus) ? page.__phoneUxLastNavigationStatus : null,
    routeClass,
    visible,
  };
}

function observeLoginResponses(page, output, stage, sampleId) {
  const listener = response => {
    if (safePath(response.url()) !== "/login") return;
    output.push({
      path: "/login",
      method: response.request().method(),
      status: response.status(),
      stage,
      sampleId,
    });
  };
  page.on("response", listener);
  return () => page.off("response", listener);
}

async function capturePrivateFailureScreenshot(context, page, artifactName) {
  try {
    await page.evaluate(() => {
      const sensitive = document.querySelectorAll(
        'input[type="password"], input[name*="token" i], input[id*="token" i], [data-testid*="token" i]',
      );
      for (const element of sensitive) {
        if (element instanceof HTMLInputElement) {
          element.value = "";
          element.setAttribute("value", "");
        }
        element.style.visibility = "hidden";
      }
    });
    const screenshotPath = context.pathInArtifacts(artifactName);
    await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled", timeout: 5_000 });
    await chmod(screenshotPath, 0o600);
    const screenshotStat = await stat(screenshotPath);
    const mode = screenshotStat.mode & 0o777;
    assert.equal(mode, 0o600, "failure screenshot must be private to the run owner");
    return {
      artifact: artifactName,
      status: "captured",
      mode: mode.toString(8).padStart(4, "0"),
      credentialInputsMasked: true,
    };
  } catch (error) {
    return {
      artifact: null,
      status: "capture-failed",
      error: context.redactText(String(error instanceof Error ? error.message : error)).slice(0, 300),
    };
  }
}

function summarizeHttpDelaySample(sample) {
  return {
    path: sanitizeGatewayPath(sample.apiPath ?? sample.path),
    status: sample.status,
    configuredDelayMs: sample.configuredDelayMs,
    jitterDelayMs: sample.jitterDelayMs,
    appliedDelayMs: sample.appliedDelayMs,
    stage: sample.stage,
  };
}

function summarizeWebSocketDelaySample(sample) {
  return {
    path: sanitizeGatewayPath(sample.path),
    method: sample.method,
    routeSocketId: sample.routeSocketId,
    configuredDelayMs: sample.configuredDelayMs,
    jitterDelayMs: sample.jitterDelayMs,
    appliedDelayMs: sample.appliedDelayMs,
    stage: sample.stage,
  };
}

async function openFixtureSession(page) {
  await ensureFixtureSessionVisible(page);
  await page.getByTestId(`thread-${THREAD_ID}`).click();
  await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 60_000 });
}

async function assertRunningControlsStayHiddenAfterTwoFrames(page, description) {
  const stopButton = page.getByTestId("stop-turn");
  const stopStatus = page.getByTestId("stop-turn-status");
  await stopButton.waitFor({ state: "hidden", timeout: 5_000 });
  await stopStatus.waitFor({ state: "hidden", timeout: 5_000 });
  const twoFramesObserved = await page.evaluate(() => new Promise(resolve => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, 3_000);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve(true);
    }));
  }));
  assert.equal(twoFramesObserved, true, `${description}: the browser did not deliver two animation frames`);
  await stopButton.waitFor({ state: "hidden", timeout: 1_000 });
  await stopStatus.waitFor({ state: "hidden", timeout: 1_000 });
}

async function measureClick(page, output, spec, context, network) {
  const id = `ux-${Math.random().toString(36).slice(2)}`;
  const urlBefore = page.url();
  const targetMeasures = [{ id, action: spec.action, targetSelector: spec.targetSelector, targetVisible: spec.targetVisible, targetText: spec.targetText },
    ...(spec.additionalTargets || []).map(target => ({
      id: `ux-${Math.random().toString(36).slice(2)}`,
      action: target.action,
      targetSelector: target.targetSelector,
      targetVisible: target.targetVisible,
      requireTargetTransition: target.requireTargetTransition ?? false,
      targetText: target.targetText,
    }))];
  await page.evaluate(values => values.forEach(value => window.__phoneUxArm(value)), targetMeasures.map(value => ({
    id: value.id,
    action: value.action,
    sourceSelector: spec.sourceSelector,
    targetSelector: value.targetSelector,
    targetVisible: value.targetVisible,
    requireTargetTransition: value.requireTargetTransition ?? false,
    targetText: value.targetText,
  })));
  const nodeStart = performance.now();
  const nodeStartEpochMs = epochNow();
  network.currentActionId = id;
  network.currentAction = spec.action;
  let error = null;
  try {
    await spec.click();
    await spec.wait();
  } catch (caught) {
    error = caught;
  }
  const browserMeasures = new Map();
  for (const target of targetMeasures) {
    const measure = await page.waitForFunction(measureId => window.__phoneUxMeasure(measureId), target.id, { timeout: 15_000 })
      .then(handle => handle.jsonValue())
      .catch(() => null);
    browserMeasures.set(target.id, measure);
  }
  const browserMeasure = browserMeasures.get(id);
  output.push({
    action: spec.action,
    actionId: id,
    cacheClass: spec.cacheClass,
    delayMs: spec.delayMs,
    durationMs: browserMeasure?.paintFeedbackMs ?? round(performance.now() - nodeStart),
    domReadyMs: browserMeasure?.domReadyMs ?? null,
    paintFeedbackMs: browserMeasure?.paintFeedbackMs ?? null,
    nodeClickStartedAtMs: round(nodeStart),
    nodeClickStartedAtEpochMs: round(nodeStartEpochMs),
    pointerDownAtEpochMs: browserMeasure?.startedAtEpochMs ?? null,
    domReadyAtEpochMs: browserMeasure?.domReadyAtEpochMs ?? null,
    paintFeedbackAtEpochMs: browserMeasure?.paintFeedbackAtEpochMs ?? null,
    timingSource: browserMeasure ? "page pointerdown to DOM-ready and two animation frames; durationMs is next-frame feedback" : "automation-observed fallback",
    ok: !error && Boolean(browserMeasure),
    ...(error ? { error: String(error.message || error).slice(0, 500) } : {}),
    ...(!browserMeasure ? { measurementReason: "page event/state observer did not capture this action" } : {}),
  });
  for (const target of targetMeasures.slice(1)) {
    const measure = browserMeasures.get(target.id);
    output.push({
      action: target.action,
      actionId: id,
      cacheClass: spec.cacheClass,
      delayMs: spec.delayMs,
      nodeClickStartedAtMs: round(nodeStart),
      durationMs: measure?.paintFeedbackMs ?? null,
      domReadyMs: measure?.domReadyMs ?? null,
      paintFeedbackMs: measure?.paintFeedbackMs ?? null,
      nodeClickStartedAtEpochMs: round(nodeStartEpochMs),
      pointerDownAtEpochMs: measure?.startedAtEpochMs ?? null,
      domReadyAtEpochMs: measure?.domReadyAtEpochMs ?? null,
      paintFeedbackAtEpochMs: measure?.paintFeedbackAtEpochMs ?? null,
      timingSource: "same page pointerdown to target DOM-ready and two animation frames",
      ok: Boolean(measure),
      ...(!measure ? { measurementReason: `target did not become visibly ready: ${target.targetSelector}` } : {}),
    });
  }
  network.currentActionId = null;
  network.currentAction = null;
  const missingTargetMeasures = targetMeasures.filter(target => !browserMeasures.get(target.id));
  if (error || missingTargetMeasures.length > 0) {
    const diagnosticId = `${spec.action}-${Date.now()}`;
    const diagnostic = await page.evaluate(measureId => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      activeMeasurement: window.__phoneUxDebug?.(measureId) ?? null,
      bodyText: document.body?.innerText?.slice(0, 4000) ?? "",
    }), targetMeasures.map(target => target.id)).catch(caught => ({ pageEvaluationError: String(caught.message || caught) }));
    await page.screenshot({ path: context.pathInArtifacts(`failure-${diagnosticId}.png`), fullPage: true }).catch(() => undefined);
    await context.writeArtifactJson(`failure-${diagnosticId}.json`, {
      action: spec.action,
      missingTargetMeasures: missingTargetMeasures.map(target => ({ action: target.action, selector: target.targetSelector })),
      urlBefore,
      urlAfter: page.url(),
      error: error ? String(error.message || error).slice(0, 500) : null,
      diagnostic: context.redactValue(diagnostic),
      recentHttp: network.http.slice(-40),
      recentHttpAppliedDelays: network.httpResponsePathDelays.slice(-40),
      recentRpc: network.rpc.slice(-60),
      recentRpcEvents: network.rpcEvents.slice(-120),
      recentWebsocketAppliedDelays: network.websocketResponsePathDelays.slice(-60),
      rpcMethodCounts: network.rpcMethodCounts,
      failedRequests: network.failedRequests,
    });
  }
  if (error) throw error;
  assert.equal(missingTargetMeasures.length, 0, `page event measurement missing for ${missingTargetMeasures.map(target => target.action).join(", ")}`);
}

async function measureDrawerAndInput(page, output, delayMs, cacheClass, index, network, sourceMode, context, navigationOnly) {
  network.currentStage = `${sourceMode}:${cacheClass}:drawer-opening`;
  await measureClick(page, output, {
    action: "drawer-open",
    cacheClass,
    delayMs,
    sourceSelector: '[aria-label="打开任务列表"]',
    targetSelector: '[data-testid="mobile-drawer"]',
    targetVisible: true,
    click: () => page.getByLabel("打开任务列表", { exact: true }).click(),
    wait: () => page.getByTestId("mobile-drawer").waitFor({ state: "visible", timeout: 15_000 }),
  }, context, network);
  network.currentStage = `${sourceMode}:${cacheClass}:drawer-open`;
  await delay(100);
  if (sourceMode === "after") {
    await page.getByTestId(`drawer-load-server-${SERVER_ID}`).waitFor({ state: "visible", timeout: 5_000 });
    await page.getByTestId(`drawer-load-projects-${SERVER_ID}`).waitFor({ state: "visible", timeout: 5_000 });
  }
  const drawerDomTrace = await beginDrawerCloseDomTrace(page, drawerCloseDiagnosticsEnabled);
  network.currentStage = `${sourceMode}:${cacheClass}:drawer-close-attempt`;
  const threadListBeforeClose = threadListRpcCount(network.rpcMethodCounts);
  const drawerCloseWindow = {
    baselineAtMs: round(performance.now()),
    baselineAtEpochMs: round(epochNow()),
    baselineThreadListCount: threadListBeforeClose,
    rpcEventStartIndex: network.rpcEvents.length,
    routedSocketCloseStartIndex: network.routedWebSocketCloseEvents.length,
    routedSocketCloseInvocationStartIndex: network.routedWebSocketCloseInvocations.length,
  };
  drawerCloseWindow.pendingAtBaseline = pendingRouteRequestsAt(network, drawerCloseWindow.baselineAtEpochMs);
  drawerCloseWindow.measureClickWrapperStartedAtMs = round(performance.now());
  drawerCloseWindow.measureClickWrapperStartedAtEpochMs = round(epochNow());
  try {
    await measureClick(page, output, {
      action: "drawer-close",
      cacheClass,
      delayMs,
      sourceSelector: '[aria-label="关闭导航"]',
      targetSelector: '[data-testid="mobile-drawer"]',
      targetVisible: false,
      click: () => page.getByLabel("关闭导航", { exact: true }).last().click(),
      wait: () => page.getByTestId("mobile-drawer").waitFor({ state: "hidden", timeout: 15_000 }),
    }, context, network);
  } catch (error) {
    drawerCloseWindow.measureClickWaitResolvedAtMs = round(performance.now());
    drawerCloseWindow.measureClickWaitResolvedAtEpochMs = round(epochNow());
    drawerCloseWindow.domTrace = await finishDrawerCloseDomTrace(page, drawerDomTrace);
    throw error;
  }
  drawerCloseWindow.measureClickWaitResolvedAtMs = round(performance.now());
  drawerCloseWindow.measureClickWaitResolvedAtEpochMs = round(epochNow());
  drawerCloseWindow.domTrace = await finishDrawerCloseDomTrace(page, drawerDomTrace);
  drawerCloseWindow.hiddenMeasure = output.filter(row => row.action === "drawer-close" && row.cacheClass === cacheClass && row.delayMs === delayMs).at(-1) ?? null;
  await delay(100);
  drawerCloseWindow.quietWindowEndedAtMs = round(performance.now());
  drawerCloseWindow.quietWindowEndedAtEpochMs = round(epochNow());
  const threadListAfterClose = threadListRpcCount(network.rpcMethodCounts);
  const closeScanRequests = Math.max(0, threadListAfterClose - threadListBeforeClose);
  const drawerCloseCheck = {
    cacheClass,
    delayMs,
    requestsAfterClose: closeScanRequests,
    requestsAfterCloseCountScope: "global aggregate across instrumented BrowserContexts; count delta alone does not attribute a request to the active page",
    drawerCloseDiagnosticsEnabled,
    diagnosticLatencyInterpretation: drawerCloseDiagnosticsEnabled ? "instrumented diagnostic timing; not an unbiased latency measurement" : "standard browser timing",
    closeCommitObservation: "React close commit is not read directly; the trace records user input, DOM mutations, CSS transitions, and the existing hidden/paint marker",
    baselineAtMs: drawerCloseWindow.baselineAtMs,
    baselineAtEpochMs: drawerCloseWindow.baselineAtEpochMs,
    measureClickWrapperStartedAtMs: drawerCloseWindow.measureClickWrapperStartedAtMs,
    measureClickWrapperStartedAtEpochMs: drawerCloseWindow.measureClickWrapperStartedAtEpochMs,
    pointerDownAtEpochMs: drawerCloseWindow.hiddenMeasure?.pointerDownAtEpochMs ?? null,
    domHiddenAtEpochMs: drawerCloseWindow.hiddenMeasure?.domReadyAtEpochMs ?? null,
    paintFeedbackAtEpochMs: drawerCloseWindow.hiddenMeasure?.paintFeedbackAtEpochMs ?? null,
    measureClickWaitResolvedAtMs: drawerCloseWindow.measureClickWaitResolvedAtMs,
    measureClickWaitResolvedAtEpochMs: drawerCloseWindow.measureClickWaitResolvedAtEpochMs,
    quietWindowEndedAtMs: drawerCloseWindow.quietWindowEndedAtMs,
    quietWindowEndedAtEpochMs: drawerCloseWindow.quietWindowEndedAtEpochMs,
    baselineThreadListCount: threadListBeforeClose,
    afterQuietThreadListCount: threadListAfterClose,
    pendingAtBaseline: drawerCloseWindow.pendingAtBaseline,
    pendingAtWindowEnd: pendingRouteRequestsAt(network, drawerCloseWindow.quietWindowEndedAtEpochMs),
    domTrace: drawerCloseWindow.domTrace,
    rpcEventStartIndex: drawerCloseWindow.rpcEventStartIndex,
    routedSocketCloseStartIndex: drawerCloseWindow.routedSocketCloseStartIndex,
    routedSocketCloseInvocationStartIndex: drawerCloseWindow.routedSocketCloseInvocationStartIndex,
  };
  network.drawerCloseListChecks.push(drawerCloseCheck);
  network.currentStage = `${sourceMode}:${cacheClass}:drawer-closed`;
  if (sourceMode === "after" && closeScanRequests !== 0) {
    const activePageEvidence = await collectPreShimNativeWebSocketEvidence(page, network);
    const rpcFrameCorrelation = correlateRpcFrames(network);
    const routeSocketOwnerById = new Map(network.routedWebSocketConnections.map(socket => [socket.id, socket.owningPageId ?? null]));
    const withRouteSocketOwner = event => ({
      ...event,
      owningPageId: routeSocketOwnerById.get(event.routeSocketId) ?? null,
    });
    const socketPageAssociations = rpcFrameCorrelation.socketPairs.map(pair => ({
      routeSocketId: pair.routeSocketId,
      applicationPageId: pair.applicationPageId,
      applicationSocketId: pair.applicationSocketId,
      pairingMode: pair.pairingMode,
    }));
    const failureAtEpochMs = round(epochNow());
    const closeWindowRpcEvents = network.rpcEvents.filter(event =>
      event.atEpochMs >= drawerCloseWindow.baselineAtEpochMs
      && event.atEpochMs <= drawerCloseWindow.quietWindowEndedAtEpochMs
      && (event.method === "thread/list" || event.method === "thread.list"),
    ).slice(-160);
    const diagnosticId = `drawer-close-${delayMs}ms-${cacheClass}-${index + 1}-${Date.now()}`;
    const screenshot = await capturePrivateFailureScreenshot(context, page, `${diagnosticId}.png`);
    const failure = context.redactValue({
      schemaVersion: 1,
      evidenceKind: "drawer-close thread/list observation window failure diagnostic",
      classification: "assertion failure preserved; this does not by itself prove a product cancellation defect because the 180ms close animation may admit work before close commit",
      cacheClass,
      delayMs,
      sampleIndex: index + 1,
      requestCountWindow: drawerCloseCheck,
      pendingAtBaseline: drawerCloseWindow.pendingAtBaseline.map(withRouteSocketOwner),
      diagnosticCapturedAtEpochMs: failureAtEpochMs,
      pendingAtWindowEnd: drawerCloseCheck.pendingAtWindowEnd.map(withRouteSocketOwner),
      activePageId: activePageEvidence?.pageId ?? null,
      routedSocketOwners: network.routedWebSocketConnections.map(socket => ({
        routeSocketId: socket.id,
        owningPageId: socket.owningPageId ?? null,
        path: socket.path,
        serverFingerprint: socket.serverFingerprint,
        channelFingerprint: socket.channelFingerprint,
        workspaceFingerprint: socket.workspaceFingerprint,
        openedAtEpochMs: socket.atEpochMs,
      })),
      routeSocketPageAssociations: socketPageAssociations,
      relevantThreadListRpcEvents: closeWindowRpcEvents.map(event => {
        const associations = socketPageAssociations.filter(pair => pair.routeSocketId === event.routeSocketId);
        return {
          ...sanitizeRpcEventForCheckpoint(event),
          owningPageId: routeSocketOwnerById.get(event.routeSocketId) ?? null,
          routeSocketPageAssociations: associations,
          activePageAssociation: activePageEvidence?.pageId == null
            ? "UNAVAILABLE"
            : associations.some(pair => pair.applicationPageId === activePageEvidence.pageId) ? "MATCHED_ACTIVE_PAGE" : associations.length ? "MATCHED_OTHER_PAGE" : "UNPAIRED_OR_AMBIGUOUS",
        };
      }),
      socketPairingDiagnostics: {
        socketPairCount: rpcFrameCorrelation.socketPairCount,
        ambiguousSocketGroups: rpcFrameCorrelation.ambiguousSocketGroups,
        unpairedRouteSockets: rpcFrameCorrelation.unpairedRouteSockets,
        activePageCapture: activePageEvidence,
      },
      routedSocketCloseEvents: network.routedWebSocketCloseEvents.slice(drawerCloseWindow.routedSocketCloseStartIndex).filter(event => event.atEpochMs <= drawerCloseWindow.quietWindowEndedAtEpochMs).map(withRouteSocketOwner),
      routedSocketCloseInvocations: network.routedWebSocketCloseInvocations.slice(drawerCloseWindow.routedSocketCloseInvocationStartIndex).filter(event => event.atEpochMs <= drawerCloseWindow.quietWindowEndedAtEpochMs).map(withRouteSocketOwner),
      drawerDomTrace: drawerCloseWindow.domTrace,
      drawerDomStateAtFailure: await describeDrawerCloseState(page),
      screenshot,
      sourceTimingBoundary: "Node epoch timestamps bracket the close attempt and existing 100ms observation window; page DOM trace records page performance and epoch clocks when --drawer-close-diagnostics is enabled; aggregate count is not attributed to the active page unless the route socket pairs uniquely",
    });
    await context.writeArtifactJson(`${diagnosticId}.json`, failure);
  }
  if (sourceMode === "after") assert.equal(closeScanRequests, 0, "closing the task drawer must not issue additional thread/list requests");
  const id = `input-${index}-${Math.random().toString(36).slice(2)}`;
  const value = `P0 draft ${index}`;
  await page.evaluate(spec => window.__phoneUxArm(spec), {
    id,
    sourceSelector: '[data-testid="message-input"]',
    targetSelector: '[data-testid="message-input"]',
    targetValue: value,
  });
  const input = page.getByTestId("message-input");
  await input.fill(value);
  const measure = await page.waitForFunction(measureId => window.__phoneUxMeasure(measureId), id, { timeout: 5_000 })
    .then(handle => handle.jsonValue())
    .catch(() => null);
  output.push({
    action: "input-feedback",
    cacheClass,
    delayMs,
    durationMs: measure?.paintFeedbackMs ?? null,
    domReadyMs: measure?.domReadyMs ?? null,
    paintFeedbackMs: measure?.paintFeedbackMs ?? null,
    timingSource: "page input event to DOM value update and two animation frames",
    ok: Boolean(measure),
    ...(!measure ? { measurementReason: "input event/state observer did not capture the value" } : {}),
  });
  assert.ok(measure, "page input feedback measurement should be captured");

  if (navigationOnly) return;

  const pendingMessage = `PHONE_UX_PENDING_${cacheClass}_${delayMs}_${index}_${Date.now()}`;
  network.currentStage = `${sourceMode}:${cacheClass}:send-local-pending`;
  await input.fill(pendingMessage);
  await measureClick(page, output, {
    action: "send-local-pending",
    cacheClass,
    delayMs,
    sourceSelector: '[data-testid="send-message"]',
    targetSelector: '[data-testid="failed-submission-content"]',
    targetVisible: true,
    additionalTargets: [
      { action: "mock-gateway-turn-start-ack", targetSelector: '[data-testid="failed-submission-content"]', targetVisible: false, requireTargetTransition: true, targetText: pendingMessage },
    ],
    targetText: pendingMessage,
    click: () => page.getByTestId("send-message").click(),
    wait: async () => {},
  }, context, network);
  await page.getByTestId("stop-turn").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("stop-turn").click();
  await page.getByTestId("stop-turn").waitFor({ state: "hidden", timeout: 30_000 });
  await waitForGatewayRpcQuiescence(network);
  network.currentStage = `${sourceMode}:${cacheClass}:send-complete`;
}

async function beginDrawerCloseDomTrace(page, enabled) {
  if (!enabled) return { enabled: false, status: "disabled" };
  return page.evaluate(() => {
    const key = "__phoneUxDrawerCloseTraceV1";
    const drawer = document.querySelector('[data-testid="mobile-drawer"]');
    const events = [];
    const describe = element => {
      if (!(element instanceof Element)) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        tagName: element.tagName.toLowerCase(),
        testId: element.getAttribute("data-testid"),
        ariaLabel: element.getAttribute("aria-label"),
        ariaHidden: element.getAttribute("aria-hidden"),
        hidden: element.hasAttribute("hidden"),
        visibility: style.visibility,
        display: style.display,
        opacity: style.opacity,
        transform: style.transform,
        rect: { x: Math.round(rect.x * 10) / 10, y: Math.round(rect.y * 10) / 10, width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 },
      };
    };
    const record = (kind, event = null, extra = {}) => {
      events.push({
        kind,
        atPagePerformanceMs: Math.round(performance.now() * 1000) / 1000,
        atEpochMs: Date.now(),
        target: describe(event?.target ?? drawer),
        ...extra,
      });
      if (events.length > 160) events.splice(0, events.length - 160);
    };
    const onPointer = event => {
      const target = event.target instanceof Element ? event.target.closest('[aria-label="关闭导航"]') : null;
      if (target) record(event.type, event, { control: describe(target) });
    };
    const onTransition = event => record(event.type, event, { propertyName: event.propertyName, elapsedTimeSeconds: event.elapsedTime });
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("pointerup", onPointer, true);
    document.addEventListener("click", onPointer, true);
    drawer?.addEventListener("transitionrun", onTransition, true);
    drawer?.addEventListener("transitionstart", onTransition, true);
    drawer?.addEventListener("transitionend", onTransition, true);
    drawer?.addEventListener("transitioncancel", onTransition, true);
    const observer = drawer ? new MutationObserver(records => {
      for (const mutation of records) record("drawer-mutation", null, { attributeName: mutation.attributeName });
    }) : null;
    observer?.observe(drawer, { attributes: true, attributeFilter: ["class", "style", "aria-hidden", "hidden", "data-state"] });
    const trace = {
      enabled: true,
      status: drawer ? "armed" : "drawer-not-found",
      armedAtPagePerformanceMs: Math.round(performance.now() * 1000) / 1000,
      pageTimeOriginEpochMs: performance.timeOrigin,
      armedAtEpochMs: Date.now(),
      events,
      cleanup() {
        document.removeEventListener("pointerdown", onPointer, true);
        document.removeEventListener("pointerup", onPointer, true);
        document.removeEventListener("click", onPointer, true);
        drawer?.removeEventListener("transitionrun", onTransition, true);
        drawer?.removeEventListener("transitionstart", onTransition, true);
        drawer?.removeEventListener("transitionend", onTransition, true);
        drawer?.removeEventListener("transitioncancel", onTransition, true);
        observer?.disconnect();
      },
    };
    globalThis[key]?.cleanup?.();
    globalThis[key] = trace;
    return { enabled: true, status: trace.status, armedAtPagePerformanceMs: trace.armedAtPagePerformanceMs, pageTimeOriginEpochMs: trace.pageTimeOriginEpochMs, armedAtEpochMs: trace.armedAtEpochMs };
  }).catch(error => ({ enabled: true, status: "arm-failed", error: String(error?.message ?? error).slice(0, 200) }));
}

async function finishDrawerCloseDomTrace(page, trace) {
  if (!trace?.enabled) return trace;
  return page.evaluate(() => {
    const key = "__phoneUxDrawerCloseTraceV1";
    const current = globalThis[key];
    if (!current) return { enabled: true, status: "trace-missing" };
    current.cleanup?.();
    const result = {
      enabled: true,
      status: current.status,
      armedAtPagePerformanceMs: current.armedAtPagePerformanceMs,
      pageTimeOriginEpochMs: current.pageTimeOriginEpochMs,
      armedAtEpochMs: current.armedAtEpochMs,
      events: current.events,
      capturedAtPagePerformanceMs: Math.round(performance.now() * 1000) / 1000,
      capturedAtEpochMs: Date.now(),
    };
    delete globalThis[key];
    return result;
  }).catch(error => ({ enabled: true, status: "capture-failed", error: String(error?.message ?? error).slice(0, 200) }));
}

async function describeDrawerCloseState(page) {
  return page.evaluate(() => {
    const describe = element => {
      if (!(element instanceof Element)) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        tagName: element.tagName.toLowerCase(),
        testId: element.getAttribute("data-testid"),
        ariaLabel: element.getAttribute("aria-label"),
        ariaHidden: element.getAttribute("aria-hidden"),
        hidden: element.hasAttribute("hidden"),
        visibility: style.visibility,
        display: style.display,
        opacity: style.opacity,
        transform: style.transform,
        rect: { x: Math.round(rect.x * 10) / 10, y: Math.round(rect.y * 10) / 10, width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 },
      };
    };
    const drawer = document.querySelector('[data-testid="mobile-drawer"]');
    const closeControls = [...document.querySelectorAll('[aria-label="关闭导航"]')].map(describe);
    return {
      pageEpochMs: Date.now(),
      pagePerformanceMs: Math.round(performance.now() * 1000) / 1000,
      pathname: globalThis.location?.pathname ?? null,
      drawer: describe(drawer),
      closeControlCount: closeControls.length,
      closeControls,
    };
  }).catch(error => ({ status: "capture-failed", error: String(error?.message ?? error).slice(0, 200) }));
}

function sanitizeRpcEventForCheckpoint(event) {
  return {
    direction: event.direction,
    method: event.method,
    rpcIdFingerprint: event.rpcIdFingerprint ?? null,
    atMs: event.atMs,
    atEpochMs: event.atEpochMs,
    stage: event.stage,
    actionId: event.actionId,
    routeSocketId: event.routeSocketId,
    path: typeof event.path === "string" ? sanitizeGatewayPath(event.path) : null,
    serverFingerprint: event.serverFingerprint ?? null,
    channelFingerprint: event.channelFingerprint ?? null,
    workspaceFingerprint: event.workspaceFingerprint ?? null,
  };
}

function pendingRouteRequestsAt(network, atEpochMs) {
  const events = [
    ...network.rpcEvents.map(event => ({ kind: "rpc", event })),
    ...network.routedWebSocketCloseEvents.map(event => ({ kind: "close", event })),
  ].filter(row => row.event.atEpochMs <= atEpochMs).sort((a, b) => a.event.atEpochMs - b.event.atEpochMs);
  const pending = new Map();
  for (const row of events) {
    const event = row.event;
    if (row.kind === "close") {
      for (const [key, request] of pending) if (request.routeSocketId === event.routeSocketId) pending.delete(key);
      continue;
    }
    if (event.direction === "request" && event.hasId && event.rpcIdFingerprint) {
      const key = `${event.routeSocketId}|${event.method}|${event.rpcIdFingerprint}`;
      pending.set(key, event);
    } else if (event.direction === "response-forwarded" || event.direction === "response-dropped") {
      pending.delete(`${event.routeSocketId}|${event.method}|${event.rpcIdFingerprint}`);
    }
  }
  return [...pending.values()].map(sanitizeRpcEventForCheckpoint);
}

function recordRoutedWebSocketCloseInvocation(network, routeSocketId, { code, reason, stage, actionId }) {
  network.routedWebSocketCloseInvocations.push({
    routeSocketId,
    code,
    reason,
    atMs: round(performance.now()),
    atEpochMs: round(epochNow()),
    stage,
    actionId,
    owner: "test-fixture",
  });
}

function beginNavigationSampleCapture(network, observations, browserErrors, delayMs, cacheClass, sampleIndex) {
  const ordinal = ++network.navigationSampleSequence;
  return {
    ordinal,
    delayMs,
    cacheClass,
    sampleIndex,
    startedAtEpochMs: round(epochNow()),
    observationStartIndex: observations.length,
    browserErrorStartIndex: browserErrors.length,
    httpRouteRequestStartIndex: network.httpRouteRequests.length,
    httpResponseDelayStartIndex: network.httpResponsePathDelays.length,
    rpcEventStartIndex: network.rpcEvents.length,
    websocketDelayStartIndex: network.websocketResponsePathDelays.length,
    routedSocketStartIndex: network.routedWebSocketConnections.length,
    routedSocketCloseStartIndex: network.routedWebSocketCloseEvents.length,
    routedSocketCloseInvocationStartIndex: network.routedWebSocketCloseInvocations.length,
    drawerCheckStartIndex: network.drawerCloseListChecks.length,
    websocketFrameCountAtStart: network.websocketFrames,
  };
}

async function writeNavigationSampleCheckpoint(context, network, capture, observations, browserErrors) {
  const finishedAtEpochMs = round(epochNow());
  const safeHttpRequest = row => ({
    path: sanitizeGatewayPath(row.apiPath ?? row.path),
    method: row.method,
    stage: row.stage,
    scenario: row.scenario ?? null,
    startedAtEpochMs: row.startedAtEpochMs ?? null,
  });
  const safeHttpResponse = row => ({
    path: sanitizeGatewayPath(row.apiPath ?? row.path),
    method: row.method,
    status: row.status,
    configuredDelayMs: row.configuredDelayMs,
    appliedDelayMs: row.appliedDelayMs,
    startedAtEpochMs: row.requestStartedAtEpochMs ?? null,
    forwardedAtEpochMs: row.forwardedAtEpochMs ?? null,
    stage: row.stage,
    scenario: row.scenario ?? null,
  });
  const safeWsDelay = row => ({
    method: row.method,
    rpcIdFingerprint: row.rpcIdFingerprint ?? null,
    routeSocketId: row.routeSocketId,
    configuredDelayMs: row.configuredDelayMs,
    appliedDelayMs: row.appliedDelayMs,
    receivedAtEpochMs: row.receivedAtEpochMs ?? null,
    forwardedAtEpochMs: row.forwardedAtEpochMs ?? null,
    stage: row.stage,
    scenario: row.scenario ?? null,
  });
  const httpRequests = network.httpRouteRequests.slice(capture.httpRouteRequestStartIndex).map(safeHttpRequest);
  const httpResponses = network.httpResponsePathDelays.slice(capture.httpResponseDelayStartIndex).map(safeHttpResponse);
  const rpcEvents = network.rpcEvents.slice(capture.rpcEventStartIndex).map(sanitizeRpcEventForCheckpoint);
  const websocketDelays = network.websocketResponsePathDelays.slice(capture.websocketDelayStartIndex).map(safeWsDelay);
  const routeSockets = network.routedWebSocketConnections.slice(capture.routedSocketStartIndex).map(row => ({
    id: row.id,
    path: typeof row.path === "string" ? sanitizeGatewayPath(row.path) : null,
    serverFingerprint: row.serverFingerprint ?? null,
    channelFingerprint: row.channelFingerprint ?? null,
    workspaceFingerprint: row.workspaceFingerprint ?? null,
    atEpochMs: row.atEpochMs,
    stage: row.stage,
  }));
  const sample = context.redactValue({
    schemaVersion: 1,
    evidenceKind: "completed Mobile Web navigation sample checkpoint",
    sample: {
      ordinal: capture.ordinal,
      delayMs: capture.delayMs,
      cacheClass: capture.cacheClass,
      sampleIndex: capture.sampleIndex,
      requiredSamplesPerClass: capture.cacheClass === "profile-setup" ? 1 : sampleCount,
      percentileEligible: capture.cacheClass !== "profile-setup" && sampleCount >= DEFAULT_SAMPLES,
      drawerCloseDiagnosticsEnabled,
      drawerCloseLatencyInterpretation: drawerCloseDiagnosticsEnabled ? "instrumented diagnostic timing; not an unbiased latency measurement" : "standard browser timing",
      startedAtEpochMs: capture.startedAtEpochMs,
      finishedAtEpochMs,
      wallElapsedMs: round(finishedAtEpochMs - capture.startedAtEpochMs),
      browserActionTimingExcludesCheckpointIo: true,
    },
    captureStatus: "COMPLETED",
    sampleOutcome: browserErrors.length > capture.browserErrorStartIndex ? "ERROR" : "NO_PAGEERROR_OBSERVED",
    observations: observations.slice(capture.observationStartIndex),
    browserErrorCount: browserErrors.length - capture.browserErrorStartIndex,
    network: {
      associationSemantics: "request-path observations are bounded by this sample window; method/id/socket/stage/action/time fields support correlation, while background fixture traffic in a live context is not automatically attributed to the measured click",
      pendingAtCheckpoint: pendingGatewayActivity(network),
      outstandingRpcRequestsAtCheckpoint: pendingRouteRequestsAt(network, finishedAtEpochMs),
      httpRouteRequestCount: httpRequests.length,
      httpResponsePathCount: httpResponses.length,
      websocketFrameCount: network.websocketFrames - capture.websocketFrameCountAtStart,
      websocketResponsePathCount: websocketDelays.length,
      rpcEventCount: rpcEvents.length,
      routeSocketCount: routeSockets.length,
      routedSocketCloseEvents: network.routedWebSocketCloseEvents.slice(capture.routedSocketCloseStartIndex),
      routedSocketCloseInvocations: network.routedWebSocketCloseInvocations.slice(capture.routedSocketCloseInvocationStartIndex),
      httpRequests,
      httpResponses,
      rpcEvents,
      websocketResponsePaths: websocketDelays,
      routeSockets,
      drawerCloseChecks: network.drawerCloseListChecks.slice(capture.drawerCheckStartIndex),
    },
    storageStatePersisted: false,
    credentialsOrResponseBodiesIncluded: false,
  });
  const cacheKey = capture.cacheClass.replace(/[^a-z0-9-]/gi, "-");
  const sampleKey = capture.sampleIndex === 0 ? "setup" : String(capture.sampleIndex).padStart(2, "0");
  await context.writeArtifactJson(`phone-ux-navigation-${capture.delayMs}ms-${cacheKey}-${sampleKey}-s${String(capture.ordinal).padStart(4, "0")}.json`, sample);
}

async function installPageInstrumentation(page, pageId) {
  await page.addInitScript(({ pageId }) => {
    const activeKey = "__phoneUxActiveMeasurementsV1";
    const completedKey = "__phoneUxCompletedMeasurementsV1";
    const debugKey = "__phoneUxEventDebugV1";
    const readStored = key => {
      try { return JSON.parse(sessionStorage.getItem(key) || "[]"); } catch { return []; }
    };
    const active = new Map(readStored(activeKey).map(measurement => [measurement.id, measurement]));
    const completed = new Map(readStored(completedKey));
    const longTasks = [];
    const events = readStored(debugKey);
    const appSocketKey = "__phoneUxApplicationWebSocketConnectionsV1";
    const appFrameKey = "__phoneUxApplicationWebSocketFramesV1";
    const appSockets = readStored(appSocketKey);
    const appFrames = readStored(appFrameKey);
    const pendingAppFrameWrites = new Set();
    const maxAppSockets = 512;
    const maxAppFrames = 8192;
    let socketOverflowCount = 0;
    let frameOverflowCount = 0;
    let storageWriteFailureCount = 0;
    let appSocketSequence = Math.max(0, ...appSockets.map(row => Number(row.socketId) || 0));
    const storeAppEvidence = () => {
      try {
        sessionStorage.setItem(appSocketKey, JSON.stringify(appSockets));
        sessionStorage.setItem(appFrameKey, JSON.stringify(appFrames));
      } catch { storageWriteFailureCount += 1; }
    };
    const digestFingerprint = async value => {
      const bytes = new TextEncoder().encode(String(value));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    };
    const applicationRouteInfo = async rawUrl => {
      try {
        const parsed = new URL(rawUrl, location.href);
        const fingerprint = async names => {
          for (const name of names) {
            const value = parsed.searchParams.get(name);
            if (value) return (await digestFingerprint(`${name}:${value}`)).slice(0, 12);
          }
          return null;
        };
        return {
          path: parsed.pathname,
          serverFingerprint: await fingerprint(["serverId", "server"]),
          channelFingerprint: await fingerprint(["channelId", "channel"]),
          workspaceFingerprint: await fingerprint(["workspaceId", "workspace"]),
        };
      } catch {
        return { path: "<invalid-url>", serverFingerprint: null, channelFingerprint: null, workspaceFingerprint: null };
      }
    };
    const recordApplicationFrame = (socket, direction, raw, atEpochMs, eventTimestampEpochMs = null) => {
      const pending = (async () => {
        if (typeof raw !== "string") return;
        let frame;
        try { frame = JSON.parse(raw); } catch { return; }
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
        const hasId = Object.hasOwn(frame, "id");
        const hasResult = Object.hasOwn(frame, "result");
        const hasError = Object.hasOwn(frame, "error");
        const method = typeof frame.method === "string" ? frame.method : null;
        if (!hasId && !hasResult && !hasError && method === null) return;
        const idFingerprint = hasId ? (await digestFingerprint(frame.id)).slice(0, 16) : null;
        const routeInfo = await socket.routeInfo;
        if (appFrames.length >= maxAppFrames) {
          frameOverflowCount += 1;
          return;
        }
        appFrames.push({
          pageId,
          direction,
          socketId: socket.socketId,
          ...routeInfo,
          method,
          rpcIdFingerprint: idFingerprint,
          hasId,
          hasResult,
          hasError,
          atEpochMs: Number(atEpochMs.toFixed(3)),
          eventTimestampEpochMs: Number.isFinite(eventTimestampEpochMs) ? Number(eventTimestampEpochMs.toFixed(3)) : null,
        });
        storeAppEvidence();
      })();
      pendingAppFrameWrites.add(pending);
      void pending.finally(() => pendingAppFrameWrites.delete(pending));
    };
    const NativeWebSocket = window.WebSocket;
    const nativeSend = NativeWebSocket.prototype.send;
    const socketMetadata = new WeakMap();
    NativeWebSocket.prototype.send = function phoneUxInstrumentedSend(raw) {
      const socket = socketMetadata.get(this);
      if (socket) recordApplicationFrame(socket, "sent", raw, performance.timeOrigin + performance.now());
      return nativeSend.call(this, raw);
    };
    const InstrumentedWebSocket = function PhoneUxInstrumentedWebSocket(...args) {
      if (!new.target) throw new TypeError("WebSocket constructor requires 'new'");
      const socket = Reflect.construct(NativeWebSocket, args, NativeWebSocket);
      const metadata = {
        pageId,
        socketId: ++appSocketSequence,
        routeInfo: applicationRouteInfo(args[0]),
      };
      socketMetadata.set(socket, metadata);
      const pendingSocketCapture = metadata.routeInfo.then(routeInfo => {
        if (appSockets.length >= maxAppSockets) {
          socketOverflowCount += 1;
          return;
        }
        appSockets.push({
          pageId,
          socketId: metadata.socketId,
          ...routeInfo,
          atEpochMs: Number((performance.timeOrigin + performance.now()).toFixed(3)),
        });
        storeAppEvidence();
      });
      pendingAppFrameWrites.add(pendingSocketCapture);
      void pendingSocketCapture.finally(() => pendingAppFrameWrites.delete(pendingSocketCapture));
      socket.addEventListener("message", event => {
        const callbackEpochMs = performance.timeOrigin + performance.now();
        const eventTimestampEpochMs = performance.timeOrigin + event.timeStamp;
        recordApplicationFrame(metadata, "received", event.data, callbackEpochMs, eventTimestampEpochMs);
      });
      return socket;
    };
    Object.setPrototypeOf(InstrumentedWebSocket, NativeWebSocket);
    InstrumentedWebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket = InstrumentedWebSocket;
    window.__phoneUxDrainApplicationWebSocketEvidence = async () => {
      while (pendingAppFrameWrites.size > 0) await Promise.all([...pendingAppFrameWrites]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      while (pendingAppFrameWrites.size > 0) await Promise.all([...pendingAppFrameWrites]);
      const evidence = {
        pageId,
        sockets: appSockets.slice(),
        frames: appFrames.slice(),
        socketOverflowCount,
        frameOverflowCount,
        storageWriteFailureCount,
        maxSocketsPerPage: maxAppSockets,
        maxFramesPerPage: maxAppFrames,
      };
      appSockets.length = 0;
      appFrames.length = 0;
      storeAppEvidence();
      return evidence;
    };
    storeAppEvidence();
    const absoluteNow = () => performance.timeOrigin + performance.now();
    const persist = () => {
      try {
        sessionStorage.setItem(activeKey, JSON.stringify([...active.values()]));
        sessionStorage.setItem(completedKey, JSON.stringify([...completed.entries()].slice(-64)));
        sessionStorage.setItem(debugKey, JSON.stringify(events.slice(-64)));
      } catch {}
    };
    const noteEvent = (measurement, eventType, target) => {
      events.push({ id: measurement.id, eventType, targetTag: target?.tagName ?? null, targetTestId: target?.getAttribute?.("data-testid") ?? null, at: Number(absoluteNow().toFixed(3)) });
      if (events.length > 64) events.splice(0, events.length - 64);
    };
    const visible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const matches = (target, selector) => {
      if (!(target instanceof Element)) return false;
      try { return Boolean(target.closest(selector)); } catch { return false; }
    };
    const stillReady = measurement => {
      const element = document.querySelector(measurement.targetSelector);
      const textMatches = measurement.targetText === undefined || (element?.textContent ?? "").includes(measurement.targetText);
      if (measurement.requireTargetTransition) {
        const isVisible = visible(element) && textMatches;
        if (isVisible) measurement.targetWasVisible = true;
        return measurement.targetWasVisible === true && !isVisible;
      }
      let ready = visible(element) === measurement.targetVisible && (measurement.targetVisible ? textMatches : true);
      if (measurement.targetValue !== undefined) ready = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value === measurement.targetValue
        : false;
      return ready;
    };
    const finish = measurement => {
      if (measurement.startedAt === null || measurement.domReadyAt !== null || !stillReady(measurement)) return;
      measurement.domReadyAt = absoluteNow();
      measurement.domReadyMs = Number((measurement.domReadyAt - measurement.startedAt).toFixed(3));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!stillReady(measurement)) {
          measurement.domReadyAt = null;
          measurement.domReadyMs = null;
          persist();
          return;
        }
        measurement.finishedAt = absoluteNow();
        measurement.paintFeedbackMs = Number((measurement.finishedAt - measurement.startedAt).toFixed(3));
        completed.set(measurement.id, {
          action: measurement.action ?? null,
          startedAtEpochMs: measurement.startedAt,
          domReadyAtEpochMs: measurement.domReadyAt,
          paintFeedbackAtEpochMs: measurement.finishedAt,
          domReadyMs: measurement.domReadyMs,
          paintFeedbackMs: measurement.paintFeedbackMs,
        });
        active.delete(measurement.id);
        persist();
      }));
    };
    window.__phoneUxArm = spec => {
      active.set(spec.id, { ...spec, startedAt: null, domReadyAt: null, finishedAt: null, domReadyMs: null, paintFeedbackMs: null });
      persist();
    };
    window.__phoneUxMeasure = id => completed.get(id) || null;
    window.__phoneUxDebug = ids => {
      const values = Array.isArray(ids) ? ids : [ids];
      return Object.fromEntries(values.map(id => [id, {
        active: active.get(id) ?? null,
        completed: completed.get(id) ?? null,
        events: events.filter(event => event.id === id),
        url: location.href,
      }]));
    };
    const begin = (event, eventType) => {
      for (const measurement of active.values()) {
        if (measurement.targetValue !== undefined && eventType !== "input") continue;
        if (measurement.targetValue === undefined && eventType !== "pointerdown") continue;
        if (measurement.startedAt !== null || !matches(event.target, measurement.sourceSelector)) continue;
        measurement.startedAt = absoluteNow();
        measurement.eventType = eventType;
        noteEvent(measurement, eventType, event.target);
        persist();
        if (eventType === "input") finish(measurement);
      }
    };
    document.addEventListener("pointerdown", event => begin(event, "pointerdown"), true);
    document.addEventListener("click", event => begin(event, "click"), true);
    document.addEventListener("input", event => begin(event, "input"), true);
    new MutationObserver(() => {
      for (const measurement of active.values()) finish(measurement);
    }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    for (const measurement of active.values()) finish(measurement);
    if (typeof PerformanceObserver === "function") {
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) longTasks.push({ startTimeMs: Number(entry.startTime.toFixed(3)), durationMs: Number(entry.duration.toFixed(3)) });
        }).observe({ type: "longtask", buffered: true });
      } catch {}
    }
    window.__phoneUxLongTasks = () => longTasks.slice();
  }, { pageId });
}

async function waitForGatewayRpcQuiescence(network, timeoutMs = 30_000, quietMs = 200) {
  const startedAt = performance.now();
  let lastActivity = gatewayActivityFingerprint(network);
  let quietStartedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const currentActivity = gatewayActivityFingerprint(network);
    const pending = pendingGatewayActivity(network);
    if (currentActivity !== lastActivity) {
      lastActivity = currentActivity;
      quietStartedAt = performance.now();
    }
    if (pending.total === 0 && performance.now() - quietStartedAt >= quietMs) {
      const report = {
        status: "DRAINED",
        elapsedMs: round(performance.now() - startedAt),
        quietWindowMs: quietMs,
        pendingAtReturn: pending,
        activityFingerprint: currentActivity,
        atEpochMs: round(epochNow()),
      };
      network.quiescenceWaits.push(report);
      return report;
    }
    await delay(25);
  }
  const pendingAtTimeout = pendingGatewayActivity(network);
  const report = {
    status: "TIMEOUT",
    elapsedMs: round(performance.now() - startedAt),
    quietWindowMs: quietMs,
    pendingAtReturn: pendingAtTimeout,
    activityFingerprint: gatewayActivityFingerprint(network),
    atEpochMs: round(epochNow()),
  };
  network.quiescenceWaits.push(report);
  throw new Error(`Gateway response paths did not drain within ${timeoutMs}ms: ${JSON.stringify(pendingAtTimeout)}`);
}

function pendingGatewayActivity(network) {
  const pendingRpc = Object.values(network.pendingRpcMethodCounts).reduce((sum, count) => sum + count, 0);
  const pendingHttp = network.pendingHttpResponses;
  const pendingWebSocketDeliveries = network.pendingWebSocketDeliveries;
  return {
    httpResponses: pendingHttp,
    websocketDeliveries: pendingWebSocketDeliveries,
    rpcResponses: pendingRpc,
    total: pendingHttp + pendingWebSocketDeliveries + pendingRpc,
  };
}

function gatewayActivityFingerprint(network) {
  return [
    network.rpcEvents.length,
    network.rpc.length,
    network.http.length,
    network.httpResponsePathDelays.length,
    network.websocketFrames,
    network.websocketResponsePathDelays.length,
    network.browserFrames.length,
    network.routedWebSocketCloseEvents.length,
  ].join(":");
}

function snapshotNetworkEvidence(network) {
  const { requestStarts: _requestStarts, ...evidence } = network;
  const snapshot = JSON.parse(JSON.stringify(evidence));
  return deepFreeze(snapshot);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function createNetworkLedger() {
  return {
    pendingHttpResponses: 0,
    pendingWebSocketDeliveries: 0,
    quiescenceWaits: [],
    http: [],
    rpc: [],
    httpRouteRequests: [],
    httpResponsePathDelays: [],
    websocketResponsePathDelays: [],
    websocketFrames: 0,
    websocketForwardErrors: 0,
    methodResponseHolds: [],
    injectedHttpStatuses: [],
    injectedWebSocketResponseDrops: [],
    faultFixtureEvents: [],
    rpcMethodCounts: Object.create(null),
    pendingRpcMethodCounts: Object.create(null),
    rpcEvents: [],
    browserFrames: [],
    browserFrameMethodCounts: Object.create(null),
    browserWebSocketPaths: [],
    browserWebSocketConnections: [],
    browserSocketSequence: 0,
    applicationPageSequence: 0,
    applicationWebSocketConnections: [],
    applicationWebSocketFrames: [],
    applicationWebSocketCaptureHealth: [],
    routedWebSocketConnections: [],
    routedWebSocketCloseEvents: [],
    routedWebSocketCloseInvocations: [],
    routedSocketSequence: 0,
    navigationSampleSequence: 0,
    currentStage: "startup",
    currentActionId: null,
    currentAction: null,
    drawerClosedListChecks: [],
    drawerCloseListChecks: [],
    failedRequests: Object.create(null),
    requestStarts: new WeakMap(),
  };
}

function summarizeObservations(observations) {
  const groups = new Map();
  for (const observation of observations) {
    const key = `${observation.action}|${observation.cacheClass}|${observation.delayMs}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(observation);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const [action, cacheClass, delayText] = key.split("|");
    const values = entries.filter(entry => entry.ok && Number.isFinite(entry.durationMs)).map(entry => entry.durationMs).sort((a, b) => a - b);
    return {
      action,
      cacheClass,
      configuredApplicationDelayMs: Number(delayText),
      sampleCount: entries.length,
      successCount: entries.filter(entry => entry.ok).length,
      errorCount: entries.filter(entry => !entry.ok).length,
      errorRate: entries.length ? Number((entries.filter(entry => !entry.ok).length / entries.length).toFixed(4)) : 0,
      percentileEligibility: values.length >= DEFAULT_SAMPLES ? "30+ samples" : "SMOKE_ONLY",
      p50Ms: values.length >= DEFAULT_SAMPLES ? percentile(values, 0.50) : null,
      p95Ms: values.length >= DEFAULT_SAMPLES ? percentile(values, 0.95) : null,
      maxMs: values.length ? values.at(-1) : null,
    };
  }).sort((a, b) => a.configuredApplicationDelayMs - b.configuredApplicationDelayMs || a.action.localeCompare(b.action) || a.cacheClass.localeCompare(b.cacheClass));
}

function scenarioStatus(rows, scenario) {
  return rows.find(row => row.scenario === scenario)?.status ?? "NOT_RUN";
}

function correlateRpcFrames(network) {
  const browserRequests = network.applicationWebSocketFrames.filter(frame => frame.direction === "sent" && frame.hasId && frame.method);
  const routeRequests = network.rpcEvents.filter(event => event.direction === "request" && event.hasId && event.method);
  const socketPairing = pairApplicationAndRouteSockets(
    network.applicationWebSocketConnections,
    network.routedWebSocketConnections,
    network.applicationWebSocketFrames,
    network.rpcEvents,
  );
  const socketPairs = socketPairing.pairs;
  const routeSocketByApplicationSocket = new Map(socketPairs.map(pair => [`${pair.applicationPageId}:${pair.applicationSocketId}`, pair.routeSocketId]));
  const requestKey = (row, routeSocketId) => `${routeSocketId}|${row.method}|${row.rpcIdFingerprint}`;
  const routeRequestCandidates = new Map();
  routeRequests.forEach((event, index) => {
    const key = requestKey(event, event.routeSocketId);
    if (!routeRequestCandidates.has(key)) routeRequestCandidates.set(key, []);
    routeRequestCandidates.get(key).push({ index, event, used: false });
  });
  const matchedRequests = [];
  const unmatchedBrowserRequests = [];
  for (const browserFrame of browserRequests) {
    const routeSocketId = routeSocketByApplicationSocket.get(`${browserFrame.pageId}:${browserFrame.socketId}`);
    const candidates = routeSocketId === undefined ? [] : routeRequestCandidates.get(requestKey(browserFrame, routeSocketId)) ?? [];
    let best = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (candidate.used) continue;
      const routeEvent = candidate.event;
      const delta = Math.abs(browserFrame.atEpochMs - routeEvent.atEpochMs);
      if (delta < bestDelta) {
        best = candidate;
        bestDelta = delta;
      }
    }
    if (!best || bestDelta > 2_000) {
      unmatchedBrowserRequests.push({
        method: browserFrame.method,
        rpcIdFingerprint: browserFrame.rpcIdFingerprint,
        applicationPageId: browserFrame.pageId,
        applicationSocketId: browserFrame.socketId,
        routeSocketId: routeSocketId ?? null,
        browserAtEpochMs: browserFrame.atEpochMs,
      });
      continue;
    }
    best.used = true;
    matchedRequests.push({
      method: browserFrame.method,
      rpcIdFingerprint: browserFrame.rpcIdFingerprint,
      browserActionId: best.event.actionId,
      routeActionId: best.event.actionId,
      applicationPageId: browserFrame.pageId,
      applicationSocketId: browserFrame.socketId,
      routeSocketId: best.event.routeSocketId,
      browserAtEpochMs: browserFrame.atEpochMs,
      routeAtEpochMs: best.event.atEpochMs,
      routeMinusBrowserMs: round(best.event.atEpochMs - browserFrame.atEpochMs),
    });
  }
  const unmatchedRouteRequests = routeRequests.flatMap((event, index) => routeRequestCandidates.get(requestKey(event, event.routeSocketId))?.find(candidate => candidate.index === index)?.used ? [] : [{
    method: event.method,
    rpcIdFingerprint: event.rpcIdFingerprint,
    actionId: event.actionId,
    routeSocketId: event.routeSocketId,
    routeAtEpochMs: event.atEpochMs,
  }]);
  const routeResponses = network.rpc.filter(row => row.rpcIdFingerprint && Number.isFinite(row.responseForwardedAtEpochMs));
  const delayedRouteResponses = routeResponses.filter(row => row.configuredDelayMs > 0);
  const browserResponses = network.applicationWebSocketFrames.filter(frame => frame.direction === "received" && frame.hasId && (frame.hasResult || frame.hasError));
  const responseCandidates = new Map();
  browserResponses.forEach((frame, index) => {
    const routeSocketId = routeSocketByApplicationSocket.get(`${frame.pageId}:${frame.socketId}`);
    if (routeSocketId === undefined) return;
    const key = `${routeSocketId}|${frame.rpcIdFingerprint}`;
    if (!responseCandidates.has(key)) responseCandidates.set(key, []);
    responseCandidates.get(key).push({ index, frame, routeSocketId, used: false });
  });
  const matchedRouteResponses = [];
  const matchedDelayedResponses = [];
  const unmatchedRouteResponses = [];
  const matchedBrowserResponseIndexes = new Set();
  for (const routeResponse of routeResponses) {
    const responseKey = `${routeResponse.routeSocketId}|${routeResponse.rpcIdFingerprint}`;
    let best = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const candidate of responseCandidates.get(responseKey) ?? []) {
      if (candidate.used) continue;
      const browserFrame = candidate.frame;
      const delta = Math.abs(browserFrame.atEpochMs - routeResponse.responseForwardedAtEpochMs);
      if (delta < bestDelta) {
        best = candidate;
        bestDelta = delta;
      }
    }
    const maxClockSkewMs = 2_000;
    if (!best || bestDelta > maxClockSkewMs) {
      unmatchedRouteResponses.push({
        method: routeResponse.method,
        rpcIdFingerprint: routeResponse.rpcIdFingerprint,
        actionId: routeResponse.actionId,
        routeSocketId: routeResponse.routeSocketId,
        configuredDelayMs: routeResponse.configuredDelayMs,
        forwardedAtEpochMs: routeResponse.responseForwardedAtEpochMs,
      });
      continue;
    }
    best.used = true;
    matchedBrowserResponseIndexes.add(best.index);
    const match = {
      method: routeResponse.method,
      rpcIdFingerprint: routeResponse.rpcIdFingerprint,
      actionId: routeResponse.actionId,
      routeSocketId: routeResponse.routeSocketId,
      applicationPageId: best.frame.pageId,
      applicationSocketId: best.frame.socketId,
      configuredDelayMs: routeResponse.configuredDelayMs,
      routeForwardedAtEpochMs: routeResponse.responseForwardedAtEpochMs,
      browserReceivedAtEpochMs: best.frame.atEpochMs,
    nativeObserverMinusRouteForwardedMs: round(best.frame.atEpochMs - routeResponse.responseForwardedAtEpochMs),
    };
    matchedRouteResponses.push(match);
    if (routeResponse.configuredDelayMs > 0) matchedDelayedResponses.push(match);
  }
  const unmatchedBrowserResponses = browserResponses.flatMap((frame, index) => matchedBrowserResponseIndexes.has(index) ? [] : [{
    method: frame.method,
    rpcIdFingerprint: frame.rpcIdFingerprint,
    applicationPageId: frame.pageId,
    applicationSocketId: frame.socketId,
    routeSocketId: routeSocketByApplicationSocket.get(`${frame.pageId}:${frame.socketId}`) ?? null,
    receivedAtEpochMs: frame.atEpochMs,
  }]);
  const countByMethod = rows => Object.fromEntries([...new Set(rows.map(row => row.method))].sort().map(method => [method, rows.filter(row => row.method === method).length]));
  const percentage = (matched, total) => total === 0 ? null : Number((matched * 100 / total).toFixed(1));
  const preShimNativeObserverBeforeForward = matchedDelayedResponses.filter(row => row.nativeObserverMinusRouteForwardedMs < -50);
  const preShimNativeObserverOffsetByConfiguredDelayMs = Object.fromEntries([...new Set(matchedDelayedResponses.map(row => row.configuredDelayMs))].sort((a, b) => a - b).map(delayMs => {
    const rows = matchedDelayedResponses.filter(row => row.configuredDelayMs === delayMs);
    return [delayMs, {
      count: rows.length,
      beforeForwardCount: rows.filter(row => row.nativeObserverMinusRouteForwardedMs < -50).length,
      offsetsMs: rows.map(row => row.nativeObserverMinusRouteForwardedMs),
    }];
  }));
  return {
    browserRequestCount: browserRequests.length,
    routeRequestCount: routeRequests.length,
    matchedRequestCount: matchedRequests.length,
    requestCoveragePercent: percentage(matchedRequests.length, browserRequests.length),
    browserRequestsByMethod: countByMethod(browserRequests),
    routeRequestsByMethod: countByMethod(routeRequests),
    unmatchedBrowserRequestsByMethod: countByMethod(unmatchedBrowserRequests),
    unmatchedRouteRequestsByMethod: countByMethod(unmatchedRouteRequests),
    matchedRequests,
    unmatchedBrowserRequests,
    unmatchedRouteRequests,
    browserResponseCount: browserResponses.length,
    routeResponseCount: routeResponses.length,
    matchedRouteResponseCount: matchedRouteResponses.length,
    unmatchedRouteResponses,
    unmatchedBrowserResponses,
    delayedRouteResponseCount: delayedRouteResponses.length,
    matchedDelayedResponseCount: matchedDelayedResponses.length,
    responseCoveragePercent: percentage(matchedRouteResponses.length, routeResponses.length),
    browserResponseCoveragePercent: percentage(matchedRouteResponses.length, browserResponses.length),
    delayedResponseCoveragePercent: percentage(matchedDelayedResponses.length, delayedRouteResponses.length),
    matchedDelayedResponses,
    preShimNativeObserverBeforeForwardCount: preShimNativeObserverBeforeForward.length,
    preShimNativeObserverOffsetByConfiguredDelayMs,
    applicationDispatchReceiptObserved: false,
    responseObservationLayer: "Playwright-captured native WebSocket transport before WebSocketMock dispatch",
    unmatchedDelayedResponses: unmatchedRouteResponses.filter(row => row.configuredDelayMs > 0),
    socketPairCount: socketPairs.length,
    applicationWebSocketCount: network.applicationWebSocketConnections.length,
    routedWebSocketCount: network.routedWebSocketConnections.length,
    socketPairs,
    ambiguousSocketGroups: socketPairing.ambiguousGroups,
    unpairedApplicationSockets: socketPairing.unpairedApplicationSockets,
    unpairedRouteSockets: socketPairing.unpairedRouteSockets,
    playwrightTransportObserverResponseCount: network.browserFrames.filter(frame => frame.direction === "received" && frame.hasId && (frame.hasResult || frame.hasError)).length,
  };
}

function pairApplicationAndRouteSockets(applicationSockets, routeSockets, applicationFrames, routeEvents) {
  const routeMetadataKey = row => JSON.stringify([
    row.path,
    row.serverFingerprint,
    row.channelFingerprint,
    row.workspaceFingerprint,
  ]);
  const appSequence = new Map();
  for (const socket of applicationSockets) {
    const rows = applicationFrames
      .filter(frame => frame.pageId === socket.pageId && frame.socketId === socket.socketId && frame.direction === "sent" && frame.method)
      .sort((a, b) => a.atEpochMs - b.atEpochMs)
      .map(frame => `${frame.method}|${frame.rpcIdFingerprint ?? "-"}`);
    appSequence.set(`${socket.pageId}:${socket.socketId}`, rows);
  }
  const routeSequence = new Map();
  for (const socket of routeSockets) {
    const rows = routeEvents
      .filter(event => event.routeSocketId === socket.id && event.direction === "request" && event.method)
      .sort((a, b) => a.atEpochMs - b.atEpochMs)
      .map(event => `${event.method}|${event.rpcIdFingerprint ?? "-"}`);
    routeSequence.set(String(socket.id), rows);
  }
  const appGroups = new Map();
  const routeGroups = new Map();
  for (const socket of applicationSockets) {
    const key = `${routeMetadataKey(socket)}|${JSON.stringify(appSequence.get(`${socket.pageId}:${socket.socketId}`) ?? [])}`;
    if (!appGroups.has(key)) appGroups.set(key, []);
    appGroups.get(key).push(socket);
  }
  for (const socket of routeSockets) {
    const key = `${routeMetadataKey(socket)}|${JSON.stringify(routeSequence.get(String(socket.id)) ?? [])}`;
    if (!routeGroups.has(key)) routeGroups.set(key, []);
    routeGroups.get(key).push(socket);
  }
  const groupKeys = new Set([...appGroups.keys(), ...routeGroups.keys()]);
  const usedApplication = new Set();
  const usedRoute = new Set();
  const pairs = [];
  const ambiguousGroups = [];
  const makePair = (applicationSocket, routeSocket, mode) => {
    const deltaMs = Math.abs(applicationSocket.atEpochMs - routeSocket.atEpochMs);
    if (deltaMs > 5_000) return false;
    const applicationKey = `${applicationSocket.pageId}:${applicationSocket.socketId}`;
    if (usedApplication.has(applicationKey) || usedRoute.has(routeSocket.id)) return false;
    usedApplication.add(applicationKey);
    usedRoute.add(routeSocket.id);
    pairs.push({
      applicationPageId: applicationSocket.pageId,
      applicationSocketId: applicationSocket.socketId,
      routeSocketId: routeSocket.id,
      path: routeSocket.path,
      serverFingerprint: routeSocket.serverFingerprint,
      channelFingerprint: routeSocket.channelFingerprint,
      workspaceFingerprint: routeSocket.workspaceFingerprint,
      requestSequenceFingerprint: sha256(JSON.stringify(appSequence.get(applicationKey) ?? [])).slice(0, 16),
      socketOpenedAtEpochMs: applicationSocket.atEpochMs,
      routeInstalledAtEpochMs: routeSocket.atEpochMs,
      absoluteOpenSkewMs: round(deltaMs),
      pairingMode: mode,
    });
    return true;
  };
  for (const key of groupKeys) {
    const appGroup = (appGroups.get(key) ?? []).slice().sort((a, b) => a.atEpochMs - b.atEpochMs);
    const routeGroup = (routeGroups.get(key) ?? []).slice().sort((a, b) => a.atEpochMs - b.atEpochMs);
    if (appGroup.length === routeGroup.length) {
      for (let index = 0; index < appGroup.length; index += 1) makePair(appGroup[index], routeGroup[index], appGroup.length === 1 ? "unique-metadata-and-full-request-sequence" : "identical-full-sequence-ordered-by-open-time");
      continue;
    }
    if (appGroup.length === 1 && routeGroup.length === 1) {
      if (makePair(appGroup[0], routeGroup[0], "unique-metadata-and-full-request-sequence")) continue;
    }
    if (appGroup.length || routeGroup.length) {
      const representative = appGroup[0] ?? routeGroup[0];
      const sequence = appGroup[0]
        ? appSequence.get(`${appGroup[0].pageId}:${appGroup[0].socketId}`) ?? []
        : routeSequence.get(String(routeGroup[0].id)) ?? [];
      ambiguousGroups.push({
        path: representative.path,
        serverFingerprint: representative.serverFingerprint,
        channelFingerprint: representative.channelFingerprint,
        workspaceFingerprint: representative.workspaceFingerprint,
        requestSequenceFingerprint: sha256(JSON.stringify(sequence)).slice(0, 16),
        applicationSocketCount: appGroup.length,
        routeSocketCount: routeGroup.length,
        reason: "Full method/ID request sequence and sanitized route metadata did not define a one-to-one timestamp-bounded socket pairing",
      });
    }
  }
  return {
    pairs: pairs.sort((a, b) => a.routeSocketId - b.routeSocketId),
    ambiguousGroups,
    unpairedApplicationSockets: applicationSockets.filter(row => !usedApplication.has(`${row.pageId}:${row.socketId}`)).map(row => ({
      pageId: row.pageId,
      socketId: row.socketId,
      path: row.path,
      serverFingerprint: row.serverFingerprint,
      channelFingerprint: row.channelFingerprint,
      workspaceFingerprint: row.workspaceFingerprint,
    })),
    unpairedRouteSockets: routeSockets.filter(row => !usedRoute.has(row.id)).map(row => ({
      routeSocketId: row.id,
      path: row.path,
      serverFingerprint: row.serverFingerprint,
      channelFingerprint: row.channelFingerprint,
      workspaceFingerprint: row.workspaceFingerprint,
    })),
  };
}

function summarizeActionTimelines(observations, network) {
  const actions = new Set([
    "task-shell-title-visible",
    "history-first-content-visible",
    "composer-ready",
    "return-home",
    "refresh-home",
    "drawer-open",
    "drawer-close",
    "input-feedback",
  ]);
  return observations.filter(row => row.actionId && actions.has(row.action)).map(row => {
    const pointerDownAt = row.pointerDownAtEpochMs;
    const routeTransactions = network.rpc.filter(rpc => rpc.actionId === row.actionId).map(rpc => ({
      method: rpc.method,
      rpcIdFingerprint: rpc.rpcIdFingerprint,
      configuredDelayMs: rpc.configuredDelayMs,
      requestSentAtEpochMs: rpc.requestSentAtEpochMs,
      responseReceivedAtEpochMs: rpc.responseReceivedAtEpochMs,
      responseForwardedAtEpochMs: rpc.responseForwardedAtEpochMs,
      requestAfterPointerDownMs: Number.isFinite(pointerDownAt) ? round(rpc.requestSentAtEpochMs - pointerDownAt) : null,
      responseAfterPointerDownMs: Number.isFinite(pointerDownAt) ? round(rpc.responseForwardedAtEpochMs - pointerDownAt) : null,
      visibleBeforeResponseForwarded: Number.isFinite(row.paintFeedbackAtEpochMs) ? row.paintFeedbackAtEpochMs < rpc.responseForwardedAtEpochMs : null,
      responsePathAppliedDelayMs: rpc.responsePathAppliedDelayMs,
      routeSocketId: rpc.routeSocketId,
    }));
    const browserRequests = network.browserFrames.filter(frame => frame.actionId === row.actionId && frame.direction === "sent" && frame.hasId && frame.method).map(frame => ({
      method: frame.method,
      rpcIdFingerprint: frame.rpcIdFingerprint,
      socketId: frame.socketId,
      atEpochMs: frame.atEpochMs,
      afterPointerDownMs: Number.isFinite(pointerDownAt) ? round(frame.atEpochMs - pointerDownAt) : null,
    }));
    return {
      action: row.action,
      actionId: row.actionId,
      cacheClass: row.cacheClass,
      configuredApplicationDelayMs: row.delayMs,
      ok: row.ok,
      clickStartedAtEpochMs: row.pointerDownAtEpochMs,
      domReadyAtEpochMs: row.domReadyAtEpochMs,
      visibleAtEpochMs: row.paintFeedbackAtEpochMs,
      domReadyMs: row.domReadyMs,
      visibleMs: row.paintFeedbackMs,
      targetSharesClickWith: observations.filter(other => other.actionId === row.actionId && other.action !== row.action).map(other => other.action),
      browserRpcRequests: browserRequests,
      routedRpcTransactions: routeTransactions,
    };
  });
}

function createCoverageLedger(delays, sampleCount, observations, network, gatewayCalls, snapshotMode) {
  const getSamples = (action, cacheClass, delayMs) => observations.filter(entry => entry.action === action && entry.cacheClass === cacheClass && entry.delayMs === delayMs && entry.ok).length;
  const requiredActionsByCache = {
    "hot-runtime": ["task-shell-title-visible", "history-first-content-visible", "composer-ready", "return-home", "drawer-open", "drawer-close", "input-feedback", "send-local-pending", "mock-gateway-turn-start-ack"],
    "cold-runtime-warm-profile": ["task-shell-title-visible", "history-first-content-visible", "composer-ready", "return-home", "refresh-home", "drawer-open", "drawer-close", "input-feedback", "send-local-pending", "mock-gateway-turn-start-ack"],
  };
  const core = delays.flatMap(delayMs => Object.entries(requiredActionsByCache).flatMap(([cacheClass, actions]) => actions.map(action => ({
    action,
    cacheClass,
    delayMs,
    samples: getSamples(action, cacheClass, delayMs),
    samplesPerRun: sampleCount,
    requiredByPlan: DEFAULT_SAMPLES,
    status: getSamples(action, cacheClass, delayMs) >= DEFAULT_SAMPLES ? "PASS" : getSamples(action, cacheClass, delayMs) > 0 ? "SMOKE" : "NOT_RUN",
  }))));
  const bothTransports = network.httpResponsePathDelays.length > 0 && network.websocketFrames > 0 && network.websocketResponsePathDelays.length > 0;
  const rpcFrameCorrelation = correlateRpcFrames(network);
  const applicationCaptureComplete = network.applicationWebSocketCaptureHealth.length > 0
    && network.applicationWebSocketCaptureHealth.every(row => row.socketOverflowCount === 0 && row.frameOverflowCount === 0 && row.storageWriteFailureCount === 0);
  const positiveDelays = delays.filter(delayMs => delayMs > 0);
  const websocketRouteCoverage = rpcFrameCorrelation.requestCoveragePercent === 100
    && rpcFrameCorrelation.responseCoveragePercent === 100
    && rpcFrameCorrelation.browserResponseCoveragePercent === 100
    && (positiveDelays.length === 0 || rpcFrameCorrelation.delayedResponseCoveragePercent === 100);
  const drawerClosedNoScans = network.drawerClosedListChecks.length > 0 && network.drawerClosedListChecks.every(row => row.requestsAfterTaskEntryBeforeDrawerOpen === 0);
  const drawerCloseNoScans = network.drawerCloseListChecks.length > 0 && network.drawerCloseListChecks.every(row => row.requestsAfterClose === 0);
  const baselineDrawerClosedStatus = drawerClosedNoScans ? "BASELINE_ZERO_OBSERVED" : "BASELINE_SCAN_OBSERVED";
  const drawerClosedStatus = snapshotMode === "before" ? baselineDrawerClosedStatus : drawerClosedNoScans ? "PASS" : "FAIL";
  const expectedMockTurnStarts = observations.filter(sample => sample.action === "send-local-pending").length;
  const observedBrowserTurnStarts = network.browserFrameMethodCounts["turn/start"] ?? 0;
  const configuredDelayEffect = positiveDelays.length > 0 && positiveDelays.every(delayMs =>
    network.httpResponsePathDelays.some(row => row.configuredDelayMs === delayMs && Number.isFinite(row.appliedDelayMs) && row.appliedDelayMs >= row.configuredDelayMs - APPLICATION_DELAY_TIMER_TOLERANCE_MS) &&
    network.websocketResponsePathDelays.some(row => row.configuredDelayMs === delayMs && Number.isFinite(row.appliedDelayMs) && row.appliedDelayMs >= row.configuredDelayMs - APPLICATION_DELAY_TIMER_TOLERANCE_MS));
  return {
    overallStatus: "PARTIAL",
    note: "P0 Mobile Web browser measurement only. PASS is scoped to the listed loopback/mock scenarios; unrun plan matrix rows remain explicit.",
    delayDefinition: "extra one-way delay applied after HTTP Gateway responses and before server-to-browser WebSocket frame delivery; not RTT or packet loss",
    coreSamples: core,
    rpcFrameCorrelation,
    matrix: [
      { id: "http-and-wss-response-path-observed", status: bothTransports ? "PATH_OBSERVED" : "PARTIAL", configuredDelaysMs: delays, httpResponseSamples: network.httpResponsePathDelays.length, websocketResponseFrames: network.websocketResponsePathDelays.length, timingBoundary: "delay is injected at HTTP response / server-to-browser frame path; configured zero validates routing only" },
      { id: "websocket-route-coverage", status: websocketRouteCoverage ? "PASS" : "PARTIAL", browserWebSocketCount: network.browserWebSocketConnections.length, routedWebSocketCount: network.routedWebSocketConnections.length, preShimNativeWebSocketCount: rpcFrameCorrelation.applicationWebSocketCount, socketPairCount: rpcFrameCorrelation.socketPairCount, ambiguousSocketGroups: rpcFrameCorrelation.ambiguousSocketGroups, browserObservedOutboundMethodCounts: network.browserFrameMethodCounts, preShimNativeRpcRequestFrames: rpcFrameCorrelation.browserRequestCount, routeRpcRequestFrames: rpcFrameCorrelation.routeRequestCount, matchedRequestFrames: rpcFrameCorrelation.matchedRequestCount, requestCoveragePercent: rpcFrameCorrelation.requestCoveragePercent, preShimNativeRpcResponses: rpcFrameCorrelation.browserResponseCount, routeRpcResponses: rpcFrameCorrelation.routeResponseCount, matchedRpcResponses: rpcFrameCorrelation.matchedRouteResponseCount, responseCoveragePercent: rpcFrameCorrelation.responseCoveragePercent, browserResponseCoveragePercent: rpcFrameCorrelation.browserResponseCoveragePercent, delayedRouteResponses: rpcFrameCorrelation.delayedRouteResponseCount, matchedDelayedResponses: rpcFrameCorrelation.matchedDelayedResponseCount, delayedResponseCoveragePercent: rpcFrameCorrelation.delayedResponseCoveragePercent, unmatchedBrowserRequestsByMethod: rpcFrameCorrelation.unmatchedBrowserRequestsByMethod, unmatchedRouteRequestsByMethod: rpcFrameCorrelation.unmatchedRouteRequestsByMethod, unmatchedDelayedResponses: rpcFrameCorrelation.unmatchedDelayedResponses, evidenceLayer: "native transport observations before Playwright WebSocketMock app dispatch", reason: websocketRouteCoverage ? null : "Native transport observations must correlate with routed request/response frames on a uniquely paired socket" },
      { id: "browser-route-rpc-frame-correlation", status: websocketRouteCoverage ? "PASS" : "PARTIAL", browserRequestsByMethod: rpcFrameCorrelation.browserRequestsByMethod, routeRequestsByMethod: rpcFrameCorrelation.routeRequestsByMethod, unmatchedBrowserRequests: rpcFrameCorrelation.unmatchedBrowserRequests, matchedRequestFrames: rpcFrameCorrelation.matchedRequestCount, unmatchedRouteRequests: rpcFrameCorrelation.unmatchedRouteRequests, unmatchedBrowserResponses: rpcFrameCorrelation.unmatchedBrowserResponses, unmatchedRouteResponses: rpcFrameCorrelation.unmatchedRouteResponses, matchedDelayedResponses: rpcFrameCorrelation.matchedDelayedResponses, ambiguousSocketGroups: rpcFrameCorrelation.ambiguousSocketGroups, preShimNativeObserverBeforeForwardCount: rpcFrameCorrelation.preShimNativeObserverBeforeForwardCount, preShimNativeObserverOffsetByConfiguredDelayMs: rpcFrameCorrelation.preShimNativeObserverOffsetByConfiguredDelayMs, timingBoundary: "Playwright-captured native transport observation correlated to routed RPC frames; it is upstream of WebSocketMock dispatch and is not app receipt" },
      { id: "pre-shim-native-websocket-evidence-capture", status: applicationCaptureComplete ? "DIAGNOSTIC_ONLY" : "FAIL", pageDrainCount: network.applicationWebSocketCaptureHealth.length, maxSocketsPerPage: Math.min(...network.applicationWebSocketCaptureHealth.map(row => row.maxSocketsPerPage)), maxFramesPerPage: Math.min(...network.applicationWebSocketCaptureHealth.map(row => row.maxFramesPerPage)), socketOverflowCount: network.applicationWebSocketCaptureHealth.reduce((sum, row) => sum + row.socketOverflowCount, 0), frameOverflowCount: network.applicationWebSocketCaptureHealth.reduce((sum, row) => sum + row.frameOverflowCount, 0), storageWriteFailureCount: network.applicationWebSocketCaptureHealth.reduce((sum, row) => sum + row.storageWriteFailureCount, 0), captureLayer: "native WebSocket captured before Playwright installs WebSocketMock", evidence: "bounded native transport observations are drained into Node after samples; this is not application-level receipt evidence" },
      { id: "application-websocket-dispatch-receipt", status: "UNVERIFIED", reason: "Playwright routeWebSocket captures the native constructor and replaces the page global with WebSocketMock; this initScript observes upstream native events, not dispatch into the app WebSocketMock/EventTarget. Delayed route forwarding and DOM visibility are measured separately." },
      { id: "positive-response-delay-effect", status: positiveDelays.length === 0 ? "NOT_RUN" : configuredDelayEffect ? "PASS" : "FAIL", configuredDelaysMs: positiveDelays, timingBoundary: "configured application-path hold, explicitly not network RTT" },
      { id: "fixture-sizes-50-500-2000-messages", status: "NOT_RUN", reason: "synthetic history volume sweep is a follow-up matrix; this first run measures navigation and local feedback" },
      { id: "slow-gateway-status-probe-12s", status: "NOT_RUN", reason: "separate 12s status-only injection not included in first core flow" },
      { id: "slow-optional-model-configuration", status: "NOT_RUN", reason: "model configuration RPC hold not included; no model RPC is sent in the core flow" },
      { id: "http-401-and-reauthorization", status: "NOT_RUN", reason: "auth expiry/401 behavior needs a dedicated isolated scenario" },
      { id: "disconnect-and-ack-loss", status: "NOT_RUN", reason: "WebSocket close and response drop require a dedicated recovery scenario" },
      { id: "jitter-and-real-packet-loss", status: "NOT_RUN", reason: "not simulated by fixed application response delays" },
      { id: "public-relay", status: "NOT_RUN_HERE", reason: "separate public validation run owns isolated test relay evidence" },
      { id: "drawer-closed-no-thread-list-scan", status: drawerClosedStatus, snapshotMode, samples: network.drawerClosedListChecks.length, nonzeroSamples: network.drawerClosedListChecks.filter(row => row.requestsAfterTaskEntryBeforeDrawerOpen > 0).length, evidence: "outbound thread/list RPC count after all startup RPCs quiesced, from task entry through interactive task shell until drawer open" },
      { id: "drawer-close-no-new-thread-list", status: snapshotMode === "before" ? (drawerCloseNoScans ? "BASELINE_ZERO_OBSERVED" : "BASELINE_SCAN_OBSERVED") : drawerCloseNoScans ? "PASS" : "FAIL", snapshotMode, samples: network.drawerCloseListChecks.length, nonzeroSamples: network.drawerCloseListChecks.filter(row => row.requestsAfterClose > 0).length, evidence: "outbound thread/list RPC count during 100ms after drawer close" },
      { id: "android-ios-hermes-native-performance", status: "UNVERIFIED", reason: "Chromium web viewport does not measure native JS/UI, keyboard, storage, or frame behavior" },
      { id: "no-real-provider-request", status: observedBrowserTurnStarts === expectedMockTurnStarts ? "PASS" : "FAIL", browserObservedMockTurnStarts: observedBrowserTurnStarts, routeObservedMockTurnStarts: gatewayCalls.turnStart, expectedPendingSamples: expectedMockTurnStarts, realProviderConfigured: false, gatewayMode: "KCODER_STUDIO_MOCK" },
    ],
  };
}

function threadListRpcCount(methodCounts) {
  return Object.entries(methodCounts)
    .filter(([method]) => /^(?:thread\/list|thread\.list)$/i.test(method))
    .reduce((sum, [, count]) => sum + count, 0);
}

  return {
    resolvePrivateBeforeComplementRoot,
    prepareSnapshot,
    reuseMobileWebExport,
    hashMobileExportSourceRoots,
    appendExportSourceFiles,
    exportSourceExcluded,
    hashBundleTree,
    prepareGatewayRuntimeSnapshot,
    inspectGatewayRuntimeSnapshot,
    hashGatewayRuntimeInputs,
    appendGatewaySnapshotFiles,
    sourceSnapshotFilter,
    dependencySnapshotFilter,
    dependencySnapshotExcluded,
    sourceSnapshotExcluded,
    assertNoEscapingLinks,
    readGatewayExecutableInputs,
    regularFileIdentity,
    gatewayRuntimeStable,
    startFrozenGateway,
    copySanitizedTree,
    createDependencySnapshot,
    removeDependencyCacheAndSecretFiles,
    dependencyExcludedCategory,
    copyArtifactTree,
    excludedCategory,
    hashComplement,
    appendFileHashes,
    listFiles,
    pruneEmptyDirectories,
    connectMobile,
    collectPreShimNativeWebSocketEvidence,
    ensureFixtureSessionVisible,
    describeVisiblePage,
    observeLoginResponses,
    capturePrivateFailureScreenshot,
    summarizeHttpDelaySample,
    summarizeWebSocketDelaySample,
    openFixtureSession,
    assertRunningControlsStayHiddenAfterTwoFrames,
    measureClick,
    measureDrawerAndInput,
    beginDrawerCloseDomTrace,
    finishDrawerCloseDomTrace,
    describeDrawerCloseState,
    sanitizeRpcEventForCheckpoint,
    pendingRouteRequestsAt,
    recordRoutedWebSocketCloseInvocation,
    beginNavigationSampleCapture,
    writeNavigationSampleCheckpoint,
    installPageInstrumentation,
    waitForGatewayRpcQuiescence,
    pendingGatewayActivity,
    gatewayActivityFingerprint,
    snapshotNetworkEvidence,
    deepFreeze,
    createNetworkLedger,
    summarizeObservations,
    scenarioStatus,
    correlateRpcFrames,
    pairApplicationAndRouteSockets,
    summarizeActionTimelines,
    createCoverageLedger,
    threadListRpcCount,
  };
}
