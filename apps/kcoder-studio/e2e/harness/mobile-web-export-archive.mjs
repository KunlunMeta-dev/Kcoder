import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { shouldOmitMobileSourceEntry as shouldOmitSourceEntry } from './mobile-source-policy.mjs';

const ARCHIVE_SCHEMA_VERSION = 1;
const ARCHIVE_KIND = "kcoder-mobile-web-export-data-archive";
const DEFAULT_ARCHIVE_DIRECTORY = "mobile-web-export-archive";
const DEFAULT_ARCHIVE_FILENAME = "bundle.archive.json";
const MAX_ARCHIVE_BYTES = 48 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const MAX_RESOURCE_COUNT = 128;
const MAX_EXPORT_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_FILE_COUNT = 4096;
const MAX_SOURCE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_TREE_BYTES = 64 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_DESTINATIONS = new Map([
  ["mobile", "apps/kcoder-studio/mobile"],
  ["studio-shared", "apps/kcoder-studio/shared"],
]);

/** Hashes the selected source roots using the exporter's source-tree contract. */
export async function inspectMobileWebExportSourceIdentity({
  sourceRoots,
  snapshotManifestPath,
  expectedSnapshotManifestSha256,
} = {}) {
  assert.ok(Array.isArray(sourceRoots) && sourceRoots.length === 2, "Mobile Web source identity requires mobile and shared roots");
  const names = new Set();
  const roots = [];
  for (const entry of sourceRoots) {
    assert.ok(entry && typeof entry === "object", "Mobile Web source root entry is invalid");
    const { name, destination } = entry;
    assert.ok(SOURCE_DESTINATIONS.has(name), `unsupported Mobile Web source root: ${String(name)}`);
    assert.equal(destination, SOURCE_DESTINATIONS.get(name), `unexpected destination for ${name} source root`);
    assert.equal(names.has(name), false, `duplicate Mobile Web source root: ${name}`);
    names.add(name);
    const sourceRoot = resolve(entry.sourceRoot ?? entry.path ?? "");
    assert.ok(sourceRoot !== resolve("/"), "Mobile Web source root cannot be the filesystem root");
    assert.equal(await realpath(sourceRoot), sourceRoot, `Mobile Web source root must not traverse a symlink: ${sourceRoot}`);
    const info = await lstat(sourceRoot);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), `Mobile Web source root is not a regular directory: ${sourceRoot}`);
    const files = await scanTree(sourceRoot, {
      maxFiles: MAX_SOURCE_FILE_COUNT,
      maxBytes: MAX_SOURCE_TREE_BYTES,
      maxFileBytes: MAX_SOURCE_FILE_BYTES,
      omitSourceEntries: true,
    });
    const rootDigest = hashJson(files.rows);
    roots.push({
      name,
      sourceRoot,
      destination,
      sha256: rootDigest,
      fileCount: files.rows.length,
    });
  }
  roots.sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(roots.map(root => root.name), ["mobile", "studio-shared"], "Mobile Web source roots are incomplete");
  const identity = {
    sourceRoots: roots,
    sourceTreeSha256: hashJson(roots.map(({ name, destination, sha256 }) => ({ name, destination, sha256 }))),
    snapshotProof: null,
  };

  const hasSnapshotPath = snapshotManifestPath !== undefined;
  const hasSnapshotSha = expectedSnapshotManifestSha256 !== undefined;
  assert.equal(hasSnapshotPath, hasSnapshotSha, "snapshot manifest path and SHA-256 pin must be supplied together");
  if (hasSnapshotPath) {
    assert.match(expectedSnapshotManifestSha256, SHA256_PATTERN, "source snapshot manifest SHA-256 pin is invalid");
    const snapshot = await inspectSourceSnapshotManifest(snapshotManifestPath, expectedSnapshotManifestSha256);
    const mobile = roots.find(root => root.name === "mobile");
    const shared = roots.find(root => root.name === "studio-shared");
    assert.equal(snapshot.manifest.mobileRoot, mobile.sourceRoot, "source snapshot mobile root differs from the requested source root");
    assert.equal(snapshot.manifest.sharedRoot, shared.sourceRoot, "source snapshot shared root differs from the requested source root");
    const expectedSourceRoot = resolve(mobile.sourceRoot, "../../..");
    assert.equal(snapshot.manifest.sourceRoot, expectedSourceRoot, "source snapshot root differs from the requested Mobile source tree");
    verifySnapshotFileTable(snapshot.manifest, snapshot.sourceRootFiles);
    identity.snapshotProof = {
      manifestPath: snapshot.manifestPath,
      manifestSha256: snapshot.manifestSha256,
      sourceRoot: snapshot.manifest.sourceRoot,
      head: snapshot.manifest.head,
    };
  }
  return identity;
}

/** Seal an already complete exporter result into one data-only private container. */
export async function archiveMobileWebExport(context, {
  exportResult,
  sourceIdentity,
  directoryName = DEFAULT_ARCHIVE_DIRECTORY,
  filename = DEFAULT_ARCHIVE_FILENAME,
} = {}) {
  assertRunContext(context);
  assertSlug(directoryName, "archive directory");
  assertSlug(filename, "archive filename");
  assert.ok(exportResult && typeof exportResult === "object", "a completed Mobile Web export result is required");
  assert.ok(sourceIdentity && typeof sourceIdentity === "object", "caller-pinned Mobile Web source identity is required");
  assert.equal(exportResult.sourceTreeSha256, sourceIdentity.sourceTreeSha256,
    "completed export source tree does not match the caller-pinned source identity");
  const verifiedIdentity = await revalidateSourceIdentity(sourceIdentity);
  assert.deepEqual(verifiedIdentity, sourceIdentity, "Mobile Web source changed after the caller selected its identity");

  const originalManifestPath = resolve(exportResult.bundleManifestPath ?? "");
  const artifactRoot = resolve(context.artifactsDir);
  assertContained(artifactRoot, originalManifestPath, "export manifest must be inside the current RunContext artifacts");
  const originalManifestBytes = await readRegularFile(originalManifestPath, MAX_EXPORT_MANIFEST_BYTES,
    "completed Mobile Web export manifest");
  const originalManifest = parseJsonDocument(originalManifestBytes, "Mobile Web export manifest");
  validateCompletedExportManifest(originalManifest, exportResult, sourceIdentity, context);

  const bundleRoot = resolveRunRelativePath(context.runRoot, originalManifest.ownedOutputRelativePath,
    "Mobile Web owned output path");
  assertContained(resolve(context.stateDir), bundleRoot, "manifest-owned Mobile Web bundle must be inside the current RunContext state");
  assert.equal(resolve(exportResult.path ?? ""), bundleRoot,
    "export result path differs from the manifest-owned Mobile Web output");
  const bundle = await inspectBundle(bundleRoot, originalManifest.bundleFiles);
  assert.equal(bundle.bundleSha256, originalManifest.bundleSha256, "exported Mobile Web bundle hash differs from its manifest");
  assert.equal(bundle.bundleSha256, exportResult.bundleSha256, "exported Mobile Web bundle hash differs from the export result");
  assert.deepEqual(normalizeResourceTable(bundle.resources), normalizeResourceTable(originalManifest.bundleFiles),
    "exported Mobile Web bundle resource table differs from its original manifest");

  const archiveValue = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    kind: ARCHIVE_KIND,
    sourceIdentity,
    origin: {
      originalRunRoot: resolve(context.runRoot),
      exportManifestPath: originalManifestPath,
      exportManifestSha256: sha256(originalManifestBytes),
      exportStartedAtUtc: originalManifest.exportStartedAtUtc,
      exportCompletedAtUtc: originalManifest.exportCompletedAtUtc,
      sourceRootSha256: originalManifest.sourceTreeSha256,
      dependencySourceTreeSha256: originalManifest.dependencyProvenance.sourceTreeSha256Before,
      dependencyOwnedTreeSha256: originalManifest.dependencyProvenance.copiedTreeSha256,
      dependencyFileCount: originalManifest.dependencyProvenance.copiedFileCount,
      dependencyRoot: originalManifest.dependencyProvenance.sourceRoot,
      exporterPid: originalManifest.exporterPid,
    },
    originalManifest: {
      sha256: sha256(originalManifestBytes),
      base64: originalManifestBytes.toString("base64"),
    },
    bundle: {
      bundleSha256: bundle.bundleSha256,
      resourceCount: bundle.resources.length,
      totalBytes: bundle.totalBytes,
      resources: bundle.resources.map(resource => ({
        path: resource.path,
        size: resource.size,
        sha256: resource.sha256,
        base64: resource.bytes.toString("base64"),
      })),
    },
  };
  const archiveBytes = Buffer.from(JSON.stringify(archiveValue));
  assert.ok(archiveBytes.length <= MAX_ARCHIVE_BYTES, "Mobile Web archive exceeds the 48 MiB container bound");
  validateArchiveValue(archiveValue, sourceIdentity);
  decodeAndVerifyArchive(archiveValue);

  const archiveParent = context.pathInArtifacts(directoryName);
  const archivePath = context.pathInArtifacts(directoryName, filename);
  assertContained(artifactRoot, archiveParent, "Mobile Web archive parent escaped RunContext artifacts");
  assertContained(archiveParent, archivePath, "Mobile Web archive file escaped its private parent");
  let parentCreated = false;
  let fileCreated = false;
  try {
    await assertPathAbsent(archiveParent, "Mobile Web archive parent already exists");
    await mkdir(archiveParent, { recursive: false, mode: 0o700 });
    parentCreated = true;
    await chmod(archiveParent, 0o700);
    assert.equal(await realpath(archiveParent), archiveParent, "Mobile Web archive parent must not traverse a symlink");
    await assertPathAbsent(archivePath, "Mobile Web archive destination already exists");
    const handle = await open(archivePath, "wx", 0o600);
    fileCreated = true;
    try {
      await handle.writeFile(archiveBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(archivePath, 0o400);
    const written = await readRegularFile(archivePath, MAX_ARCHIVE_BYTES, "written Mobile Web archive");
    assert.equal(sha256(written), sha256(archiveBytes), "written Mobile Web archive bytes changed");
    assertArchivePrivateModes(await lstat(archiveParent), await lstat(archivePath));
    assert.deepEqual(await readdir(archiveParent), [filename], "Mobile Web archive parent must contain exactly one data container");
    return {
      path: archivePath,
      sha256: sha256(written),
      size: written.length,
      resourceCount: bundle.resources.length,
      totalResourceBytes: bundle.totalBytes,
      bundleSha256: bundle.bundleSha256,
      sourceIdentity: verifiedIdentity,
      originalManifestSha256: archiveValue.origin.exportManifestSha256,
      originalRunRoot: archiveValue.origin.originalRunRoot,
      dependencyProvenanceIsHistorical: true,
      archiveMode: "0400",
      archiveParentMode: "0700",
    };
  } catch (error) {
    if (fileCreated) await rm(archivePath, { force: true }).catch(() => {});
    if (parentCreated) await rmdir(archiveParent).catch(() => {});
    throw error;
  }
}

/** Validate all archive/source bytes first, then restore a deletable RunContext tree. */
export async function restoreMobileWebExportArchive(context, {
  archivePath,
  expectedArchiveSha256,
  sourceIdentity,
  outputName = "mobile-web-export-archive-restored",
} = {}) {
  return restoreMobileWebExportArchiveWithPolicy(context, {
    archivePath,
    expectedArchiveSha256,
    sourceIdentity,
    outputName,
  }, { mode: "current-source" });
}

/** Restore a pinned historical baseline without claiming it matches today's source tree. */
export async function restoreHistoricalMobileWebExportArchive(context, {
  archivePath,
  expectedArchiveSha256,
  expectedHistoricalSourceIdentity,
  historicalSourceHead,
  expectedHistoricalRunManifestSha256,
  outputName = "mobile-web-export-historical-baseline",
} = {}) {
  assert.match(historicalSourceHead ?? "", /^[a-f0-9]{40}$/, "historical Mobile Web source HEAD pin is required");
  assert.match(expectedHistoricalRunManifestSha256 ?? "", SHA256_PATTERN,
    "historical Mobile Web RunContext manifest SHA-256 pin is required");
  return restoreMobileWebExportArchiveWithPolicy(context, {
    archivePath,
    expectedArchiveSha256,
    sourceIdentity: expectedHistoricalSourceIdentity,
    outputName,
  }, { mode: "historical-baseline", historicalSourceHead, expectedHistoricalRunManifestSha256 });
}

async function restoreMobileWebExportArchiveWithPolicy(context, {
  archivePath,
  expectedArchiveSha256,
  sourceIdentity,
  outputName,
}, policy) {
  assertRunContext(context);
  assert.match(expectedArchiveSha256 ?? "", SHA256_PATTERN, "expected archive SHA-256 is required");
  assert.ok(sourceIdentity && typeof sourceIdentity === "object", "caller-pinned source identity is required");
  assertSlug(outputName, "restored bundle output name");
  const archiveFile = resolve(archivePath ?? "");
  const archiveBytes = await readPrivateArchive(archiveFile);
  assert.equal(sha256(archiveBytes), expectedArchiveSha256, "Mobile Web archive SHA-256 differs from the caller pin");
  const archiveValue = parseJsonCanonical(archiveBytes, "Mobile Web data-only archive");
  const verifiedIdentity = policy.mode === "current-source"
    ? await revalidateSourceIdentity(sourceIdentity)
    : validateHistoricalSourceIdentity(sourceIdentity);
  validateArchiveValue(archiveValue, verifiedIdentity);
  assert.deepEqual(archiveValue.sourceIdentity, verifiedIdentity,
    "Mobile Web archive is bound to a different selected source identity");
  const historicalRunManifest = policy.mode === "historical-baseline"
    ? await verifyHistoricalRunManifest(archiveValue, policy.historicalSourceHead, policy.expectedHistoricalRunManifestSha256)
    : null;
  const decoded = decodeAndVerifyArchive(archiveValue);

  const stateRoot = resolve(context.stateDir);
  assert.equal(await realpath(stateRoot), stateRoot, "RunContext state root must not traverse a symlink");
  const ownedRoot = context.pathInState(outputName);
  assertContained(stateRoot, ownedRoot, "restored Mobile Web bundle escaped RunContext state");
  await assertPathAbsent(ownedRoot, "restored Mobile Web bundle destination already exists");
  await mkdir(ownedRoot, { recursive: false, mode: 0o700 });
  await chmod(ownedRoot, 0o700);
  context.registerTemporaryDirectory("verified archived Mobile Web bundle", ownedRoot);

  try {
    for (const resource of decoded.resources) {
      const destination = resolve(ownedRoot, ...resource.path.split("/"));
      assertContained(ownedRoot, destination, `restored bundle resource escaped RunContext state: ${resource.path}`);
      await makePrivateDirectories(ownedRoot, resource.path.split("/").slice(0, -1));
      const handle = await open(destination, "wx", 0o600);
      try {
        await handle.writeFile(resource.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(destination, 0o400);
    }
    const restored = await inspectBundle(ownedRoot, decoded.resources);
    assert.equal(restored.bundleSha256, decoded.bundleSha256, "restored bundle changed after extraction");
    await verifyOwnedModes(ownedRoot);
    const archiveAfter = await readPrivateArchive(archiveFile);
    assert.equal(sha256(archiveAfter), expectedArchiveSha256, "Mobile Web archive changed during extraction");
  } catch (error) {
    await rm(ownedRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const mobileSource = verifiedIdentity.sourceRoots.find(root => root.name === "mobile");
  return {
    path: ownedRoot,
    sourceRoot: mobileSource.sourceRoot,
    sourceRoots: verifiedIdentity.sourceRoots.map(root => ({ ...root })),
    sourceTreeSha256: verifiedIdentity.sourceTreeSha256,
    bundleSha256: decoded.bundleSha256,
    bundleFileCount: decoded.resources.length,
    bundleFiles: decoded.resources.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })),
    indexHtmlSha256: decoded.resources.find(resource => resource.path === "index.html")?.sha256 ?? null,
    inputKind: policy.mode === "historical-baseline" ? "archived-baseline" : "verified-readonly-data-archive",
    archivePath: archiveFile,
    archiveSha256: expectedArchiveSha256,
    originalManifestSha256: archiveValue.origin.exportManifestSha256,
    origin: { ...archiveValue.origin },
    ...(historicalRunManifest ? {
      historicalSourceHead: policy.historicalSourceHead,
      originalRunManifestSha256: historicalRunManifest.sha256,
    } : {}),
    dependencyProvenanceIsHistorical: true,
  };
}

function validateHistoricalSourceIdentity(identity) {
  assertExactKeys(identity, ["sourceRoots", "sourceTreeSha256", "snapshotProof"], "historical Mobile Web source identity pin");
  assert.match(identity.sourceTreeSha256 ?? "", SHA256_PATTERN, "historical Mobile Web source tree SHA-256 pin is invalid");
  assert.ok(Array.isArray(identity.sourceRoots) && identity.sourceRoots.length === 2,
    "historical Mobile Web source identity pin must contain two roots");
  assert.deepEqual(identity.sourceRoots.map(root => root?.name).sort(), ["mobile", "studio-shared"],
    "historical Mobile Web source identity pin must contain mobile and shared roots");
  assert.equal(identity.sourceTreeSha256, hashJson(identity.sourceRoots
    .map(({ name, destination, sha256: digest }) => ({ name, destination, sha256: digest }))
    .sort((left, right) => left.name.localeCompare(right.name))),
  "historical Mobile Web source identity pin digest does not match its roots");
  assert.equal(identity.snapshotProof, null,
    "historical Mobile Web baseline requires an explicit source identity without an unverified snapshot proof");
  for (const root of identity.sourceRoots) {
    assertExactKeys(root, ["name", "sourceRoot", "destination", "sha256", "fileCount"],
      `historical ${root.name} source root pin`);
    assert.equal(root.destination, SOURCE_DESTINATIONS.get(root.name),
      `historical ${root.name} source destination pin is invalid`);
    assert.ok(typeof root.sourceRoot === "string" && isAbsolute(root.sourceRoot),
      `historical ${root.name} source root path pin is invalid`);
    assert.match(root.sha256 ?? "", SHA256_PATTERN, `historical ${root.name} source digest pin is invalid`);
    assert.ok(Number.isSafeInteger(root.fileCount) && root.fileCount > 0,
      `historical ${root.name} source file count pin is invalid`);
  }
  return identity;
}

async function verifyHistoricalRunManifest(archiveValue, expectedSourceHead, expectedManifestSha256) {
  const runRoot = resolve(archiveValue.origin.originalRunRoot);
  assert.notEqual(runRoot, resolve("/"), "historical Mobile Web RunContext root cannot be the filesystem root");
  assert.equal(await realpath(runRoot), runRoot, "historical Mobile Web RunContext root must not traverse a symlink");
  const rootInfo = await lstat(runRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "historical Mobile Web RunContext root is not a regular directory");
  const manifestPath = resolve(runRoot, "manifest.json");
  assertContained(runRoot, manifestPath, "historical Mobile Web RunContext manifest escaped its root");
  const bytes = await readRegularFile(manifestPath, MAX_EXPORT_MANIFEST_BYTES, "historical Mobile Web RunContext manifest");
  assert.equal(sha256(bytes), expectedManifestSha256,
    "historical Mobile Web RunContext manifest SHA-256 differs from the caller pin");
  const manifest = parseJsonDocument(bytes, "historical Mobile Web RunContext manifest");
  assert.equal(manifest.schemaVersion, 1, "unsupported historical Mobile Web RunContext manifest schema");
  assert.equal(manifest.gitCommit, expectedSourceHead,
    "historical Mobile Web RunContext HEAD differs from the caller pin");
  return { sha256: sha256(bytes) };
}

/** Recheck either a fresh export or restored archive before RunContext cleanup. */
export async function verifyMobileWebExportUnchanged(mobileWeb) {
  assert.ok(mobileWeb && typeof mobileWeb.path === "string", "Mobile Web export result is required");
  const bundle = await inspectBundle(resolve(mobileWeb.path), mobileWeb.bundleFiles);
  assert.equal(bundle.bundleSha256, mobileWeb.bundleSha256, "Mobile Web bundle changed after validation");
  if (mobileWeb.archivePath || mobileWeb.archiveSha256) {
    assert.ok(mobileWeb.archivePath && mobileWeb.archiveSha256, "archive path and SHA-256 must be present together");
    const archiveBytes = await readPrivateArchive(mobileWeb.archivePath);
    assert.equal(sha256(archiveBytes), mobileWeb.archiveSha256, "Mobile Web archive changed after validation");
  }
  return {
    unchanged: true,
    bundleSha256: bundle.bundleSha256,
    resourceCount: bundle.resources.length,
    totalBytes: bundle.totalBytes,
  };
}

async function revalidateSourceIdentity(identity) {
  assertExactKeys(identity, ["sourceRoots", "sourceTreeSha256", "snapshotProof"], "Mobile Web source identity");
  assert.match(identity.sourceTreeSha256 ?? "", SHA256_PATTERN, "Mobile Web source tree SHA-256 is invalid");
  assert.ok(Array.isArray(identity.sourceRoots) && identity.sourceRoots.length === 2,
    "Mobile Web source identity must contain two roots");
  let snapshotOptions = {};
  if (identity.snapshotProof !== null) {
    assertExactKeys(identity.snapshotProof, ["manifestPath", "manifestSha256", "sourceRoot", "head"], "source snapshot proof");
    snapshotOptions = {
      snapshotManifestPath: identity.snapshotProof.manifestPath,
      expectedSnapshotManifestSha256: identity.snapshotProof.manifestSha256,
    };
  }
  const current = await inspectMobileWebExportSourceIdentity({
    sourceRoots: identity.sourceRoots,
    ...snapshotOptions,
  });
  assert.deepEqual(current, identity, "selected Mobile Web source tree or snapshot proof changed");
  return current;
}

async function inspectSourceSnapshotManifest(manifestPath, expectedSha256) {
  const resolvedManifestPath = resolve(manifestPath);
  assert.equal(await realpath(resolvedManifestPath), resolvedManifestPath,
    "source snapshot manifest must not traverse a symlink");
  const bytes = await readRegularFile(resolvedManifestPath, MAX_SOURCE_MANIFEST_BYTES, "source snapshot manifest");
  assert.equal(sha256(bytes), expectedSha256, "source snapshot manifest differs from its caller pin");
  const manifest = parseJsonDocument(bytes, "source snapshot manifest");
  assert.ok(manifest && manifest.kind === "owned-readonly-p1-mobile-and-shared-input",
    "unsupported Mobile source snapshot manifest kind");
  assert.ok(typeof manifest.sourceRoot === "string" && typeof manifest.mobileRoot === "string" &&
    typeof manifest.sharedRoot === "string" && typeof manifest.head === "string",
  "source snapshot manifest identity fields are incomplete");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_SOURCE_FILE_COUNT,
    "source snapshot manifest file count is outside its bound");
  const sourceRoot = resolve(manifest.sourceRoot);
  assert.equal(await realpath(sourceRoot), sourceRoot, "source snapshot root must not traverse a symlink");
  const sourceRootFiles = await scanTree(sourceRoot, {
    maxFiles: MAX_SOURCE_FILE_COUNT,
    maxBytes: MAX_SOURCE_TREE_BYTES,
    maxFileBytes: MAX_SOURCE_FILE_BYTES,
  });
  return { manifestPath: resolvedManifestPath, manifestSha256: expectedSha256, manifest, sourceRootFiles };
}

function verifySnapshotFileTable(manifest, sourceRootFiles) {
  const rows = manifest.files.map(row => {
    assertExactKeys(row, ["path", "bytes", "sha256"], "source snapshot file row");
    const path = safeRelativePath(row.path);
    assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= MAX_SOURCE_FILE_BYTES,
      `source snapshot file size is invalid: ${path}`);
    assert.match(row.sha256, SHA256_PATTERN, `source snapshot file SHA-256 is invalid: ${path}`);
    return { path, size: row.bytes, sha256: row.sha256 };
  }).sort(comparePath);
  assert.equal(new Set(rows.map(row => row.path)).size, rows.length, "source snapshot manifest contains duplicate paths");
  assert.deepEqual(rows, sourceRootFiles.rows, "source snapshot files changed or contain missing/extra files");
}

function validateCompletedExportManifest(manifest, exportResult, sourceIdentity, context) {
  assert.ok(manifest && manifest.schemaVersion === 2, "unsupported Mobile Web export manifest schema");
  assert.equal(manifest.status, "complete", "only complete Mobile Web exports can be archived");
  assert.equal(manifest.failurePhase, null, "completed Mobile Web export has a failure phase");
  assert.equal(manifest.error, null, "completed Mobile Web export has an error");
  assert.deepEqual(manifest.verificationFailures, [], "Mobile Web export manifest contains verification failures");
  for (const field of ["sourceUnchanged", "snapshotCopyMatchesSource", "terminalHookChangesOnlyGeneratedHtml",
    "snapshotUnchangedDuringExport"]) {
    assert.equal(manifest[field], true, `Mobile Web export guard failed: ${field}`);
  }
  assert.equal(manifest.overallDeadline?.outcome, "completed", "Mobile Web export deadline did not complete");
  validateManifestConsistency(manifest, sourceIdentity, "Mobile Web export manifest");
  assert.ok(typeof manifest.ownedOutputRelativePath === "string", "Mobile Web export output path is missing");
  const ownedOutputPath = resolveRunRelativePath(context.runRoot, manifest.ownedOutputRelativePath,
    "Mobile Web owned output path");
  assertContained(resolve(context.stateDir), ownedOutputPath,
    "manifest-owned Mobile Web output must be inside the current RunContext state");
  assert.equal(resolve(exportResult.path ?? ""), ownedOutputPath,
    "export result path differs from the manifest-owned Mobile Web output");
  assert.equal(exportResult.buildInputTreeSha256, manifest.buildInputTreeAfterCopySha256,
    "export result copied-source digest differs from the manifest");
  assert.equal(exportResult.dependencySourceTreeSha256, manifest.dependencyProvenance.sourceTreeSha256Before,
    "export result dependency source digest differs from the manifest");
  assert.equal(exportResult.dependencyOwnedTreeSha256, manifest.dependencyProvenance.copiedTreeSha256,
    "export result copied dependency digest differs from the manifest");
  assert.ok(Array.isArray(manifest.bundleFiles) && manifest.bundleFiles.length > 0,
    "Mobile Web export manifest has no bundle resources");
  assert.equal(manifest.bundleFileCount, manifest.bundleFiles.length, "Mobile Web export resource count is inconsistent");
  assert.equal(manifest.bundleSha256, hashJson(normalizeResourceTable(manifest.bundleFiles)),
    "Mobile Web export manifest bundle SHA-256 is invalid");
  assert.equal(manifest.bundleSha256, exportResult.bundleSha256, "Mobile Web result and manifest bundle digests differ");
  assert.equal(manifest.bundleFileCount, exportResult.bundleFileCount, "Mobile Web result and manifest file counts differ");
  assert.deepEqual(normalizeResourceTable(manifest.bundleFiles), normalizeResourceTable(exportResult.bundleFiles),
    "Mobile Web result and manifest resource tables differ");
  assert.ok(manifest.bundleFiles.some(file => file.path === "index.html"), "Mobile Web bundle is missing index.html");
  assert.equal(manifest.indexHtmlSha256, manifest.bundleFiles.find(file => file.path === "index.html")?.sha256,
    "Mobile Web index.html SHA-256 is inconsistent");
  assert.ok(typeof manifest.exportStartedAtUtc === "string" && typeof manifest.exportCompletedAtUtc === "string",
    "Mobile Web export timestamps are missing");
}

function validateManifestConsistency(manifest, sourceIdentity, label) {
  const sourceTreeSha256 = sourceIdentity.sourceTreeSha256;
  assert.match(sourceTreeSha256 ?? "", SHA256_PATTERN, `${label} caller source tree SHA-256 is invalid`);
  for (const field of ["sourceTreeSha256", "sourceHashBefore", "sourceHashAfter"]) {
    assert.match(manifest[field] ?? "", SHA256_PATTERN, `${label} ${field} is invalid`);
    assert.equal(manifest[field], sourceTreeSha256, `${label} ${field} differs from the caller-pinned source tree`);
  }
  for (const field of ["buildInputTreeBeforeCopySha256", "buildInputTreeAfterCopySha256",
    "buildInputTreeBeforeTerminalSha256", "buildInputTreeBeforeTerminalExcludingGeneratedSha256",
    "buildInputTreeAfterTerminalSha256", "buildInputTreeAfterExportSha256"]) {
    assert.match(manifest[field] ?? "", SHA256_PATTERN, `${label} ${field} is invalid`);
  }
  assert.equal(manifest.buildInputTreeBeforeCopySha256, sourceTreeSha256,
    `${label} copy input digest differs from the source tree`);
  assert.equal(manifest.buildInputTreeAfterCopySha256, sourceTreeSha256,
    `${label} copied source digest differs from the source tree`);
  assert.equal(manifest.buildInputTreeBeforeTerminalSha256, manifest.buildInputTreeBeforeCopySha256,
    `${label} owned source changed before the terminal build hook`);
  // The manifest omits the post-hook excluding-generated digest; the exporter guard records that comparison.
  assert.equal(manifest.buildInputTreeAfterTerminalSha256, manifest.buildInputTreeAfterExportSha256,
    `${label} owned source changed during export`);
  assert.deepEqual(normalizeSourceRoots(manifest.inputRoots), normalizeSourceRoots(sourceIdentity.sourceRoots),
    `${label} source roots differ from the caller-pinned identity`);
  assert.deepEqual(normalizeSourceRoots(manifest.inputRootsAfter), normalizeSourceRoots(sourceIdentity.sourceRoots),
    `${label} post-export source roots differ from the caller-pinned identity`);

  const dependency = manifest.dependencyProvenance;
  assert.ok(dependency && typeof dependency === "object", `${label} dependency provenance is missing`);
  assert.match(dependency.sourceTreeSha256Before ?? "", SHA256_PATTERN,
    `${label} dependency source-before SHA-256 is invalid`);
  assert.match(dependency.sourceTreeSha256After ?? "", SHA256_PATTERN,
    `${label} dependency source-after SHA-256 is invalid`);
  assert.equal(dependency.sourceTreeSha256Before, dependency.sourceTreeSha256After,
    `${label} dependency source digests disagree`);
  assert.equal(dependency.sourceUnchanged, true, `${label} dependency input changed during export`);
  assert.match(dependency.copiedTreeSha256 ?? "", SHA256_PATTERN,
    `${label} copied dependency SHA-256 is invalid`);
  assert.ok(Number.isSafeInteger(dependency.copiedFileCount) && dependency.copiedFileCount > 0,
    `${label} copied dependency file count is invalid`);
  assert.equal(dependency.copiedSymlinks, false, `${label} copied dependency tree contains symlinks`);
}

function validateArchiveValue(value, expectedSourceIdentity) {
  assertExactKeys(value, ["schemaVersion", "kind", "sourceIdentity", "origin", "originalManifest", "bundle"],
    "Mobile Web archive");
  assert.equal(value.schemaVersion, ARCHIVE_SCHEMA_VERSION, "unsupported Mobile Web archive schema");
  assert.equal(value.kind, ARCHIVE_KIND, "unsupported Mobile Web archive kind");
  assert.deepEqual(value.sourceIdentity, expectedSourceIdentity, "Mobile Web archive source identity does not match the caller pin");
  assertExactKeys(value.origin, ["originalRunRoot", "exportManifestPath", "exportManifestSha256", "exportStartedAtUtc",
    "exportCompletedAtUtc", "sourceRootSha256", "dependencySourceTreeSha256", "dependencyOwnedTreeSha256",
    "dependencyFileCount", "dependencyRoot", "exporterPid"], "Mobile Web archive origin proof");
  assert.match(value.origin.exportManifestSha256 ?? "", SHA256_PATTERN, "original export manifest SHA-256 is invalid");
  assert.equal(value.origin.sourceRootSha256, expectedSourceIdentity.sourceTreeSha256,
    "archive origin proof is bound to a different source tree");
  assert.match(value.origin.dependencySourceTreeSha256 ?? "", SHA256_PATTERN, "historical dependency source SHA-256 is invalid");
  assert.match(value.origin.dependencyOwnedTreeSha256 ?? "", SHA256_PATTERN, "historical owned dependency SHA-256 is invalid");
  assert.ok(Number.isSafeInteger(value.origin.dependencyFileCount) && value.origin.dependencyFileCount > 0,
    "historical dependency file count is invalid");
  assert.ok(typeof value.origin.originalRunRoot === "string" && typeof value.origin.exportManifestPath === "string" &&
    typeof value.origin.dependencyRoot === "string", "Mobile Web archive origin paths are incomplete");
  const originalArtifactsRoot = resolve(value.origin.originalRunRoot, "artifacts");
  assertContained(originalArtifactsRoot, resolve(value.origin.exportManifestPath),
    "original export manifest provenance escaped its RunContext artifacts");
  assert.ok(Number.isFinite(Date.parse(value.origin.exportStartedAtUtc)) &&
    Number.isFinite(Date.parse(value.origin.exportCompletedAtUtc)), "Mobile Web export provenance timestamps are invalid");
  assert.ok(value.origin.exporterPid === null ||
    (Number.isSafeInteger(value.origin.exporterPid) && value.origin.exporterPid > 0), "Mobile Web exporter PID provenance is invalid");
  assertExactKeys(value.originalManifest, ["sha256", "base64"], "archived original export manifest");
  assert.match(value.originalManifest.sha256 ?? "", SHA256_PATTERN, "archived original manifest SHA-256 is invalid");
  assert.ok(typeof value.originalManifest.base64 === "string", "archived original manifest bytes are missing");
  assertExactKeys(value.bundle, ["bundleSha256", "resourceCount", "totalBytes", "resources"], "archived Mobile Web bundle");
  assert.match(value.bundle.bundleSha256 ?? "", SHA256_PATTERN, "archived bundle SHA-256 is invalid");
  assert.ok(Array.isArray(value.bundle.resources) && value.bundle.resources.length > 0 &&
    value.bundle.resources.length <= MAX_RESOURCE_COUNT, "archived resource count exceeds the bound");
  assert.equal(value.bundle.resourceCount, value.bundle.resources.length, "archived resource count is inconsistent");
  assert.ok(Number.isSafeInteger(value.bundle.totalBytes) && value.bundle.totalBytes > 0 &&
    value.bundle.totalBytes <= MAX_BUNDLE_BYTES, "archived Mobile Web bundle size exceeds 32 MiB");
  const paths = new Set();
  let totalBytes = 0;
  const table = [];
  for (const resource of value.bundle.resources) {
    assertExactKeys(resource, ["path", "size", "sha256", "base64"], "archived resource row");
    const path = safeRelativePath(resource.path);
    assert.equal(paths.has(path), false, `Mobile Web archive contains a duplicate resource: ${path}`);
    paths.add(path);
    assert.ok(Number.isSafeInteger(resource.size) && resource.size >= 0 && resource.size <= MAX_RESOURCE_BYTES,
      `Mobile Web archive resource exceeds 16 MiB: ${path}`);
    assert.match(resource.sha256, SHA256_PATTERN, `Mobile Web archive resource SHA-256 is invalid: ${path}`);
    assert.ok(typeof resource.base64 === "string", `Mobile Web archive resource bytes are missing: ${path}`);
    totalBytes += resource.size;
    table.push({ path, size: resource.size, sha256: resource.sha256 });
  }
  assert.equal(totalBytes, value.bundle.totalBytes, "archived Mobile Web total size is inconsistent");
  assert.equal(hashJson(table), value.bundle.bundleSha256, "archived Mobile Web resource table hash is invalid");
  assert.deepEqual(table, [...table].sort(comparePath), "Mobile Web archive resources are not in canonical path order");
  assert.equal(value.originalManifest.sha256, value.origin.exportManifestSha256,
    "archived original manifest SHA-256 does not match its provenance");
  const manifestBytes = decodeBase64(value.originalManifest.base64, MAX_EXPORT_MANIFEST_BYTES,
    "archived original export manifest");
  assert.equal(sha256(manifestBytes), value.originalManifest.sha256, "archived original export manifest bytes changed");
  const manifest = parseJsonDocument(manifestBytes, "archived original export manifest");
  assert.equal(manifest.status, "complete", "archived original export manifest is not complete");
  validateManifestAgainstArchive(manifest, value);
  assert.ok(totalBytes <= MAX_BUNDLE_BYTES, "Mobile Web archive resource sum exceeds 32 MiB");
  assert.equal(table.some(resource => resource.path === "index.html"), true, "archived Mobile Web bundle is missing index.html");
  const base64Length = value.bundle.resources.reduce((sum, resource) => sum + resource.base64.length, value.originalManifest.base64.length);
  assert.ok(base64Length <= MAX_ARCHIVE_BYTES, "Mobile Web archive base64 payload exceeds its bound");
  return manifest;
}

function validateManifestAgainstArchive(manifest, archiveValue) {
  assert.equal(manifest.schemaVersion, 2, "unsupported original Mobile Web manifest schema");
  assert.equal(manifest.status, "complete", "original Mobile Web manifest is not complete");
  assert.equal(manifest.failurePhase, null, "original Mobile Web manifest has a failure phase");
  assert.equal(manifest.error, null, "original Mobile Web manifest has an error");
  assert.deepEqual(manifest.verificationFailures, [], "original Mobile Web manifest records verification failures");
  for (const field of ["sourceUnchanged", "snapshotCopyMatchesSource", "terminalHookChangesOnlyGeneratedHtml",
    "snapshotUnchangedDuringExport"]) {
    assert.equal(manifest[field], true, `original Mobile Web export guard failed: ${field}`);
  }
  validateManifestConsistency(manifest, archiveValue.sourceIdentity, "original Mobile Web manifest");
  assert.equal(manifest.overallDeadline?.outcome, "completed", "original Mobile Web export deadline did not complete");
  assert.equal(manifest.exportStartedAtUtc, archiveValue.origin.exportStartedAtUtc,
    "original export start time differs from its origin proof");
  assert.equal(manifest.exportCompletedAtUtc, archiveValue.origin.exportCompletedAtUtc,
    "original export completion time differs from its origin proof");
  assert.equal(manifest.exporterPid, archiveValue.origin.exporterPid,
    "original exporter PID differs from its origin proof");
  assert.equal(manifest.dependencyProvenance.sourceTreeSha256Before, archiveValue.origin.dependencySourceTreeSha256,
    "historical dependency source digest differs from its origin proof");
  assert.equal(manifest.dependencyProvenance.copiedTreeSha256, archiveValue.origin.dependencyOwnedTreeSha256,
    "historical copied dependency digest differs from its origin proof");
  assert.equal(manifest.dependencyProvenance.copiedFileCount, archiveValue.origin.dependencyFileCount,
    "historical copied dependency count differs from its origin proof");
  assert.equal(manifest.dependencyProvenance.sourceRoot, archiveValue.origin.dependencyRoot,
    "historical dependency root differs from its origin proof");
  const ownedOutputPath = resolveRunRelativePath(archiveValue.origin.originalRunRoot,
    manifest.ownedOutputRelativePath, "original Mobile Web owned output path");
  assertContained(resolve(archiveValue.origin.originalRunRoot, "state"), ownedOutputPath,
    "original manifest-owned bundle escaped its RunContext state");
  const resources = normalizeResourceTable(archiveValue.bundle.resources);
  assert.deepEqual(normalizeResourceTable(manifest.bundleFiles), resources,
    "archived resources differ from the original Mobile Web manifest");
  assert.equal(manifest.bundleFileCount, resources.length, "original Mobile Web manifest resource count differs");
  assert.equal(manifest.bundleSha256, archiveValue.bundle.bundleSha256,
    "original Mobile Web manifest bundle SHA-256 differs from archived resources");
}

function decodeAndVerifyArchive(value) {
  const manifestBytes = decodeBase64(value.originalManifest.base64, MAX_EXPORT_MANIFEST_BYTES,
    "archived original export manifest");
  const manifest = parseJsonDocument(manifestBytes, "archived original export manifest");
  validateManifestAgainstArchive(manifest, value);
  const resources = value.bundle.resources.map(resource => {
    const bytes = decodeBase64(resource.base64, MAX_RESOURCE_BYTES, `archived resource ${resource.path}`);
    assert.equal(bytes.length, resource.size, `archived resource size differs: ${resource.path}`);
    assert.equal(sha256(bytes), resource.sha256, `archived resource SHA-256 differs: ${resource.path}`);
    return { path: resource.path, size: resource.size, sha256: resource.sha256, bytes };
  }).sort(comparePath);
  assert.equal(hashJson(resources.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }))),
    value.bundle.bundleSha256, "decoded Mobile Web bundle table hash differs");
  assert.equal(resources.reduce((sum, row) => sum + row.size, 0), value.bundle.totalBytes,
    "decoded Mobile Web bundle total size differs");
  return { resources, bundleSha256: value.bundle.bundleSha256 };
}

async function inspectBundle(root, expectedRows) {
  assert.equal(await realpath(root), root, "Mobile Web bundle root must not traverse a symlink");
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "Mobile Web bundle root must be a regular directory");
  const scanned = await scanTree(root, {
    maxFiles: MAX_RESOURCE_COUNT,
    maxBytes: MAX_BUNDLE_BYTES,
    maxFileBytes: MAX_RESOURCE_BYTES,
    requireSingleLink: true,
  });
  const expected = normalizeResourceTable(expectedRows);
  assert.deepEqual(scanned.rows, expected, "Mobile Web bundle contains missing, extra, changed, or unsafe resources");
  const expectedDirectories = [...new Set(expected.flatMap(row => {
    const segments = row.path.split("/");
    return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
  }))].sort(compareText);
  assert.deepEqual(scanned.directories, expectedDirectories, "Mobile Web bundle contains an extra or missing directory");
  const bundleSha256 = hashJson(expected);
  return { resources: scanned.rows.map(row => ({ ...row, bytes: scanned.bytesByPath.get(row.path) })), totalBytes: scanned.totalBytes, bundleSha256 };
}

async function scanTree(root, { maxFiles, maxBytes, maxFileBytes, requireSingleLink = false, omitSourceEntries = false }) {
  const rows = [];
  const bytesByPath = new Map();
  const directories = [];
  let totalBytes = 0;
  async function visit(directory, relativeDirectory = "") {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childPath = resolve(directory, child.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (omitSourceEntries && shouldOmitSourceEntry(child.name, relativePath, child.isDirectory())) continue;
      const info = await lstat(childPath);
      assert.equal(info.isSymbolicLink(), false, `tree contains a symlink: ${relativePath}`);
      if (info.isDirectory()) {
        directories.push(relativePath);
        await visit(childPath, relativePath);
        continue;
      }
      assert.ok(info.isFile(), `tree contains a special file: ${relativePath}`);
      assert.ok(info.size <= maxFileBytes, `tree file exceeds its size bound: ${relativePath}`);
      if (requireSingleLink) assert.equal(info.nlink, 1, `bundle file has a shared hard link: ${relativePath}`);
      const bytes = await readFile(childPath);
      assert.equal(bytes.length, info.size, `tree file size changed while hashing: ${relativePath}`);
      totalBytes += bytes.length;
      assert.ok(totalBytes <= maxBytes, "tree exceeds its total byte bound");
      rows.push({ path: safeRelativePath(relativePath), size: bytes.length, sha256: sha256(bytes) });
      bytesByPath.set(relativePath, bytes);
      assert.ok(rows.length <= maxFiles, "tree contains more files than its count bound");
    }
  }
  await visit(root);
  rows.sort(comparePath);
  directories.sort(compareText);
  return { rows, bytesByPath, directories, totalBytes };
}

async function readPrivateArchive(path) {
  const resolved = resolve(path);
  const parent = dirname(resolved);
  assert.equal(await realpath(parent), parent, "Mobile Web archive parent must not traverse a symlink");
  const parentInfo = await lstat(parent);
  const fileInfo = await lstat(resolved);
  assert.ok(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), "Mobile Web archive parent is unsafe");
  assert.ok(fileInfo.isFile() && !fileInfo.isSymbolicLink(), "Mobile Web archive must be one regular data file");
  assert.equal(fileInfo.nlink, 1, "Mobile Web archive must not be hard-linked");
  assertArchivePrivateModes(parentInfo, fileInfo);
  if (typeof process.getuid === "function") {
    assert.equal(parentInfo.uid, process.getuid(), "Mobile Web archive parent is not owned by this test user");
    assert.equal(fileInfo.uid, process.getuid(), "Mobile Web archive is not owned by this test user");
  }
  assert.ok(fileInfo.size > 0 && fileInfo.size <= MAX_ARCHIVE_BYTES, "Mobile Web archive exceeds 48 MiB");
  const entries = await readdir(parent);
  assert.deepEqual(entries, [resolved.slice(parent.length + 1)], "Mobile Web archive parent must contain exactly one container");
  const bytes = await readFile(resolved);
  assert.equal(bytes.length, fileInfo.size, "Mobile Web archive size changed while reading");
  return bytes;
}

function assertArchivePrivateModes(parentInfo, fileInfo) {
  assert.equal(parentInfo.mode & 0o777, 0o700, "Mobile Web archive parent mode must be 0700");
  assert.equal(fileInfo.mode & 0o777, 0o400, "Mobile Web archive file mode must be 0400");
}

async function readRegularFile(path, maximumBytes, label) {
  const resolved = resolve(path);
  assert.equal(await realpath(resolved), resolved, `${label} must not traverse a symlink`);
  const info = await lstat(resolved);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  assert.equal(info.nlink, 1, `${label} must not be hard-linked`);
  assert.ok(info.size > 0 && info.size <= maximumBytes, `${label} exceeds its size bound`);
  const bytes = await readFile(resolved);
  assert.equal(bytes.length, info.size, `${label} changed while reading`);
  return bytes;
}

function parseJsonCanonical(bytes, label) {
  const text = Buffer.from(bytes).toString("utf8");
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`${label} is invalid JSON: ${error.message}`); }
  assert.equal(JSON.stringify(value), text, `${label} is not canonical JSON or contains duplicate keys`);
  return value;
}

function parseJsonDocument(bytes, label) {
  const text = Buffer.from(bytes).toString("utf8");
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label} is invalid JSON: ${error.message}`); }
}

function decodeBase64(value, maximumBytes, label) {
  assert.ok(typeof value === "string" && value.length <= Math.ceil(maximumBytes / 3) * 4 + 4,
    `${label} base64 payload exceeds its bound`);
  const bytes = Buffer.from(value, "base64");
  assert.equal(bytes.toString("base64"), value, `${label} is not canonical base64`);
  assert.ok(bytes.length <= maximumBytes, `${label} exceeds its byte bound`);
  return bytes;
}

function normalizeResourceTable(rows) {
  assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= MAX_RESOURCE_COUNT,
    "Mobile Web resource table is outside its count bound");
  const normalized = rows.map(row => {
    assert.ok(row && typeof row === "object", "Mobile Web resource row is invalid");
    const path = safeRelativePath(row.path);
    const size = row.size;
    assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= MAX_RESOURCE_BYTES,
      `Mobile Web resource size is invalid: ${path}`);
    assert.match(row.sha256 ?? "", SHA256_PATTERN, `Mobile Web resource SHA-256 is invalid: ${path}`);
    return { path, size, sha256: row.sha256 };
  }).sort(comparePath);
  assert.equal(new Set(normalized.map(row => row.path)).size, normalized.length, "Mobile Web resource table contains duplicate paths");
  const totalBytes = normalized.reduce((sum, row) => sum + row.size, 0);
  assert.ok(totalBytes <= MAX_BUNDLE_BYTES, "Mobile Web resource table exceeds 32 MiB");
  return normalized;
}

function normalizeSourceRoots(rows) {
  assert.ok(Array.isArray(rows) && rows.length === 2, "Mobile Web manifest source roots are invalid");
  const normalized = rows.map(row => {
    assert.ok(row && typeof row === "object", "Mobile Web source root row is invalid");
    const expectedDestination = SOURCE_DESTINATIONS.get(row.name);
    assert.ok(expectedDestination, `Mobile Web source root name is unsupported: ${String(row.name)}`);
    assert.equal(row.destination, expectedDestination, `Mobile Web source root destination is invalid: ${row.name}`);
    assert.match(row.sha256 ?? "", SHA256_PATTERN, `Mobile Web source root SHA-256 is invalid: ${row.name}`);
    assert.ok(Number.isSafeInteger(row.fileCount) && row.fileCount > 0 && row.fileCount <= MAX_SOURCE_FILE_COUNT,
      `Mobile Web source root file count is invalid: ${row.name}`);
    return {
      name: row.name,
      sourceRoot: resolve(row.sourceRoot),
      destination: row.destination,
      sha256: row.sha256,
      fileCount: row.fileCount,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(normalized.map(root => root.name), ["mobile", "studio-shared"], "Mobile Web source roots are incomplete or duplicated");
  return normalized;
}

async function makePrivateDirectories(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    assertContained(root, current, "restored Mobile Web directory escaped its root");
    try {
      await mkdir(current, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), "restored Mobile Web path contains a non-directory or symlink");
    await chmod(current, 0o700);
  }
}

async function verifyOwnedModes(root) {
  const rootInfo = await lstat(root);
  assert.equal(rootInfo.mode & 0o777, 0o700, "restored bundle root mode must be 0700");
  const tree = await scanTree(root, {
    maxFiles: MAX_RESOURCE_COUNT,
    maxBytes: MAX_BUNDLE_BYTES,
    maxFileBytes: MAX_RESOURCE_BYTES,
  });
  for (const directory of tree.directories) {
    const info = await lstat(resolve(root, directory));
    assert.equal(info.mode & 0o777, 0o700, `restored bundle directory mode must be 0700: ${directory}`);
  }
  for (const row of tree.rows) {
    const info = await lstat(resolve(root, ...row.path.split("/")));
    assert.equal(info.mode & 0o777, 0o400, `restored bundle resource mode must be 0400: ${row.path}`);
  }
}

async function assertPathAbsent(path, message) {
  try { await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  throw new Error(message);
}

function safeRelativePath(value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 1024,
    "Mobile Web resource path is invalid");
  assert.ok(!value.includes("\\") && !value.includes("\0"), "Mobile Web resource path must use POSIX separators");
  assert.ok(!value.startsWith("/") && !/^[a-zA-Z]:/.test(value), "Mobile Web resource path must be relative");
  const segments = value.split("/");
  assert.ok(segments.every(segment => segment.length > 0 && segment !== "." && segment !== ".."),
    "Mobile Web resource path contains an unsafe segment");
  return value;
}

function resolveRunRelativePath(root, value, label) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0"),
    `${label} is invalid`);
  assert.ok(!isAbsolute(value) && !value.startsWith("/") && !value.startsWith("\\") && !/^[a-zA-Z]:/.test(value),
    `${label} must be relative`);
  const segments = value.split(/[\\/]/);
  assert.ok(segments.every(segment => segment.length > 0 && segment !== "." && segment !== ".."),
    `${label} contains an unsafe segment`);
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, ...segments);
  assertContained(resolvedRoot, resolvedPath, `${label} escaped its RunContext`);
  return resolvedPath;
}

function assertExactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or unexpected fields`);
}

function assertRunContext(context) {
  assert.ok(context && typeof context.pathInArtifacts === "function" && typeof context.pathInState === "function",
    "a RunContext is required");
  assert.ok(typeof context.registerTemporaryDirectory === "function", "RunContext temporary-directory registration is required");
  assert.ok(typeof context.artifactsDir === "string" && typeof context.stateDir === "string" && typeof context.runRoot === "string",
    "RunContext path roots are required");
}

function assertSlug(value, label) {
  assert.ok(typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value), `${label} is invalid`);
}

function assertContained(root, path, message) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  assert.ok(normalizedPath !== normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}${sep}`), message);
}

function comparePath(left, right) {
  return left.path.localeCompare(right.path);
}

function compareText(left, right) {
  return left.localeCompare(right);
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
