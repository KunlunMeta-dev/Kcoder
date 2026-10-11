// One-time Mobile Web export from an immutable private candidate.
// Candidate bytes are read only; the sanitized dependency pin is retained privately.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";

const candidateLabel = process.env.PHONE_AUTH_EXPORT_CANDIDATE_LABEL ?? "2050";
assert.match(candidateLabel, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/);
const candidateRelativeRoot =
  process.env.PHONE_AUTH_EXPORT_CANDIDATE_ROOT ??
  "target/private-phone-latency-implementation/after-final-mobile-gateway-20261007-2050";
const candidateRoot = resolve(repoRoot, candidateRelativeRoot);
assert.ok(
  candidateRoot.startsWith(`${resolve(repoRoot, "target/private-phone-latency-implementation")}${sep}`),
  "candidate root must be a frozen private phone-latency input",
);
const expectedCandidateDigest = process.env.PHONE_AUTH_EXPORT_CANDIDATE_DIGEST ??
  "64c9049ea4788d14d7e591739cb63d68641e03d2ca2a52c2b9815b417ba30d7a";
const expectedCandidateFiles = Number(process.env.PHONE_AUTH_EXPORT_CANDIDATE_FILES ?? "354");
assert.match(expectedCandidateDigest, /^[0-9a-f]{64}$/);
assert.ok(Number.isSafeInteger(expectedCandidateFiles) && expectedCandidateFiles > 0);
const beforeDependencySourceDigest =
  "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c";
const beforeDependencyOwnedDigest =
  "754d1db10bd502faeb0b6e82820d455cae680166008a443f7397457f1ef21d29";
const pinnedDependencyRoot = resolve(
  repoRoot,
  process.env.PHONE_AUTH_EXPORT_DEPENDENCY_ROOT ??
    "target/private-phone-ux-implementation/mobile-dependency-input-pinned",
);
assert.ok(
  pinnedDependencyRoot.startsWith(`${resolve(repoRoot, "target/private-phone-ux-implementation")}${sep}`),
  "pinned dependency root must remain under the private phone UX input directory",
);
const exportLabel = `mobile-device-auth-${candidateLabel}-export`;
const exportOutputName = `mobile-device-auth-${candidateLabel}-web-export`;
const exportRoot = resolve(
  repoRoot,
  process.env.PHONE_AUTH_EXPORT_OUTPUT_ROOT ??
    `target/private-phone-ux-implementation/mobile-web-export-${candidateLabel}`,
);
assert.ok(
  exportRoot.startsWith(`${resolve(repoRoot, "target/private-phone-ux-implementation")}${sep}`),
  "export output must remain under the private phone UX input directory",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function candidateMetadataFileCount(metadata, expectedFiles) {
  const declaredCounts = [metadata.sourceFiles, metadata.files].filter(
    value => value !== undefined,
  );
  assert.ok(declaredCounts.length > 0, "candidate metadata must declare sourceFiles or files");
  assert.ok(
    declaredCounts.every(value => Number.isSafeInteger(value) && value > 0),
    "candidate metadata file counts must be positive safe integers",
  );
  assert.ok(
    declaredCounts.every(value => value === expectedFiles),
    "candidate metadata file count differs from the pinned expected count",
  );
  assert.equal(
    new Set(declaredCounts).size,
    1,
    "candidate metadata sourceFiles and files counts conflict",
  );
  return declaredCounts[0];
}

async function verifyCandidate() {
  const metadata = JSON.parse(
    await readFile(join(candidateRoot, "metadata.json"), "utf8"),
  );
  assert.equal(metadata.sourceDigest, expectedCandidateDigest);
  const metadataFileCount = candidateMetadataFileCount(metadata, expectedCandidateFiles);
  const manifest = JSON.parse(
    await readFile(join(candidateRoot, "sha256.json"), "utf8"),
  );
  const entries = Object.entries(manifest);
  assert.equal(entries.length, metadataFileCount, "candidate manifest count differs from metadata");
  for (const [path, expected] of entries) {
    assert.equal(
      sha256(await readFile(join(candidateRoot, path))),
      expected,
      `frozen source hash mismatch: ${path}`,
    );
  }
  for (const path of [
    "apps/kcoder-studio/mobile/package.json",
    "apps/kcoder-studio/mobile/app.json",
    "apps/kcoder-studio/mobile/app.config.ts",
    "apps/kcoder-studio/mobile/metro.config.cjs",
    "apps/kcoder-studio/mobile/tsconfig.json",
    "apps/kcoder-studio/mobile/scripts/build-terminal-webview.mjs",
  ]) assert.ok(manifest[path], `required frozen Expo input is absent: ${path}`);
  return { metadata, manifest, metadataFileCount };
}

function excludedDependencyCategory(name, isDirectory) {
  if (isDirectory && name === ".vite") return "generated-vite-cache-directory";
  if (name === ".env" || /^\.env\.(?!example(?:\.|$))/i.test(name))
    return "environment-file";
  if ([".npmrc", "credentials.json", "account_credentials.json"].includes(name))
    return "credential-file";
  if (/(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name))
    return "credential-named-file";
  if (/\.(?:pem|key|p12|pfx|keystore)$/i.test(name))
    return "cryptographic-key-material";
  return null;
}

async function assertPrivateCanonicalDirectory(path, label) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a real directory`);
  assert.equal(await realpath(path), resolve(path), `${label} must resolve to its canonical path`);
  if (typeof process.getuid === "function") assert.equal(info.uid, process.getuid(), `${label} must be owned by this user`);
  assert.equal(info.mode & 0o077, 0, `${label} must not grant group or other access`);
  return info;
}

async function hashPinnedDependencyRoot(root) {
  const rootReal = await realpath(root);
  const files = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const category = excludedDependencyCategory(child.name, child.isDirectory());
      assert.equal(category, null, `private dependency pin contains excluded ${category}: ${child.name}`);
      const path = resolve(directory, child.name);
      const info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), `private dependency pin contains a symlink: ${relative(rootReal, path)}`);
      if (info.isDirectory()) {
        await visit(path);
      } else if (info.isFile()) {
        const bytes = await readFile(path);
        files.push({ path: relative(rootReal, path).split(sep).join("/"), size: bytes.length, sha256: sha256(bytes) });
      } else {
        assert.fail(`private dependency pin contains a non-regular file: ${relative(rootReal, path)}`);
      }
    }
  }
  await visit(rootReal);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const rootDigest = sha256(Buffer.from(JSON.stringify(files)));
  // Match exportMobileWeb hashSourceRoots(name=mobile-dependencies, includeNodeModules=true)
  // and its outer root aggregation. The root label and canonical destination are part of the digest.
  return sha256(Buffer.from(JSON.stringify([{
    name: "mobile-dependencies",
    destination: "apps/kcoder-studio/mobile/node_modules",
    sha256: rootDigest,
  }])));
}

async function ensurePinnedDependencySnapshot() {
  const parent = resolve(pinnedDependencyRoot, "..");
  const parentInfo = await lstat(parent);
  assert.ok(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), "private dependency parent must be a real directory");
  assert.equal(await realpath(parent), parent, "private dependency parent must resolve canonically");
  const pinInfo = await assertPrivateCanonicalDirectory(pinnedDependencyRoot, "pinned dependency snapshot");
  await accessRequiredExpo(pinnedDependencyRoot);
  const preflightSourceTreeSha256 = await hashPinnedDependencyRoot(pinnedDependencyRoot);
  assert.equal(
    preflightSourceTreeSha256,
    beforeDependencySourceDigest,
    "existing pinned dependency source differs from the exact recorded helper source namespace digest",
  );
  return {
    sourceRoot: pinnedDependencyRoot,
    destination: pinnedDependencyRoot,
    excludedContentCounts: Object.create(null),
    copyPid: null,
    copyOwnerPid: null,
    reusedExisting: true,
    pinnedRootMode: pinInfo.mode & 0o777,
    preflightSourceTreeSha256,
    copySemantics: "reused the existing private pinned snapshot after canonical-path, owner, mode, no-symlink, excluded-content, and helper-namespace source digest checks; exportMobileWeb still creates its required run-owned build copy",
  };
}

async function accessRequiredExpo(root) {
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "Mobile dependency root must be a real directory");
  await readFile(join(root, "expo/package.json"), "utf8");
}

async function assertPathAbsent(path, message) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.fail(message);
}

async function copyArtifactTree(sourceRoot, destinationRoot) {
  await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const source = resolve(sourceRoot, entry.name);
    const destination = resolve(destinationRoot, entry.name);
    const info = await lstat(source);
    assert.ok(!info.isSymbolicLink(), `export output contains a symlink: ${entry.name}`);
    if (info.isDirectory()) await copyArtifactTree(source, destination);
    else if (info.isFile()) await cp(source, destination, { errorOnExist: true });
    else assert.fail(`export output contains a non-regular file: ${entry.name}`);
  }
}

async function hashArtifactTree(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      const info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), `artifact contains a symlink: ${relativePath}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        const bytes = await readFile(path);
        files.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
      } else assert.fail(`artifact contains a non-regular file: ${relativePath}`);
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, sha256: sha256(Buffer.from(JSON.stringify(files))) };
}

await runE2E(
  import.meta.url,
  {
    testId: "mobile-device-auth-final-web-export-review",
    tier: "full-integration",
    modelPolicy:
      "one immutable-source Mobile Web export for isolated Chromium UI authorization review; no real Provider or Gateway session",
    retainSuccessLogs: true,
  },
  async context => {
    const { metadata, manifest, metadataFileCount } = await verifyCandidate();
    await assertPathAbsent(exportRoot, "refusing to replace a prior final export artifact");
    await assertPathAbsent(
      join(exportRoot, "..", `mobile-web-export-${candidateLabel}-manifest.json`),
      "refusing to replace a prior final export manifest",
    );
    await assertPathAbsent(
      join(exportRoot, "..", `mobile-web-export-${candidateLabel}-provenance.json`),
      "refusing to replace prior final export provenance",
    );
    const mobileRoot = join(candidateRoot, "apps/kcoder-studio/mobile");
    const sharedRoot = join(candidateRoot, "apps/kcoder-studio/shared");
    const dependencySnapshot = await ensurePinnedDependencySnapshot();

    const exported = await exportMobileWeb(context, {
      mobileRoot,
      sourceRoots: [
        { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
        { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
      ],
      dependencyRoot: dependencySnapshot.destination,
      label: exportLabel,
      outputName: exportOutputName,
    });
    const buildManifest = JSON.parse(await readFile(exported.bundleManifestPath, "utf8"));
    assert.equal(buildManifest.status, "complete", buildManifest.error ?? "Mobile Web export failed");
    assert.equal(buildManifest.sourceUnchanged, true);
    assert.equal(buildManifest.snapshotCopyMatchesSource, true);
    assert.equal(buildManifest.snapshotUnchangedDuringExport, true);
    assert.equal(buildManifest.dependencyProvenance.sourceUnchanged, true);
    assert.equal(buildManifest.terminalHookChangesOnlyGeneratedHtml, true);
    assert.equal(
      exported.dependencySourceTreeSha256,
      beforeDependencySourceDigest,
      "sanitized pinned dependency source digest differs from the exact before exporter input",
    );
    assert.equal(
      exported.dependencyOwnedTreeSha256,
      beforeDependencyOwnedDigest,
      "exporter-owned dependency copy digest differs from the exact before owned input",
    );

    await copyArtifactTree(exported.path, exportRoot);
    const copiedBundle = await hashArtifactTree(exportRoot);
    assert.equal(copiedBundle.sha256, exported.bundleSha256);
    assert.deepEqual(copiedBundle.files, exported.bundleFiles);

    const candidateMobileFiles = Object.keys(manifest).filter(path =>
      path.startsWith("apps/kcoder-studio/mobile/"),
    ).length;
    const candidateSharedFiles = Object.keys(manifest).filter(path =>
      path.startsWith("apps/kcoder-studio/shared/"),
    ).length;
    const provenance = {
      status: "complete",
      candidateRoot,
      candidateDigest: metadata.sourceDigest,
      candidateFiles: metadataFileCount,
      candidateMobileManifestFiles: candidateMobileFiles,
      candidateSharedManifestFiles: candidateSharedFiles,
      candidateManifestPath: join(candidateRoot, "sha256.json"),
      sourceTreeSha256: exported.sourceTreeSha256,
      sourceRoots: exported.sourceRoots,
      sourceUnchanged: buildManifest.sourceUnchanged,
      snapshotCopyMatchesSource: buildManifest.snapshotCopyMatchesSource,
      snapshotUnchangedDuringExport: buildManifest.snapshotUnchangedDuringExport,
      terminalHookChangesOnlyGeneratedHtml: buildManifest.terminalHookChangesOnlyGeneratedHtml,
      bundlePath: exportRoot,
      bundleSha256: copiedBundle.sha256,
      bundleFileCount: copiedBundle.files.length,
      indexHtmlSha256: exported.indexHtmlSha256,
      dependencyInput: {
        sourceRoot: dependencySnapshot.sourceRoot,
        privateRoot: dependencySnapshot.destination,
        copyPid: dependencySnapshot.copyPid,
        copyOwnerPid: dependencySnapshot.copyOwnerPid,
        reusedExisting: dependencySnapshot.reusedExisting,
        pinnedRootMode: dependencySnapshot.pinnedRootMode,
        preflightSourceTreeSha256: dependencySnapshot.preflightSourceTreeSha256,
        copySemantics: dependencySnapshot.copySemantics,
        excludedContentCounts: dependencySnapshot.excludedContentCounts,
        sourceTreeSha256: exported.dependencySourceTreeSha256,
        ownedTreeSha256: exported.dependencyOwnedTreeSha256,
        digestSemantics: {
          source: "exportMobileWeb hashSourceRoots(name=mobile-dependencies,destination=apps/kcoder-studio/mobile/node_modules) over the sanitized pinned input",
          owned: "same content materialized into the owned build, hashed under name=owned-mobile-dependencies; aggregate differs because the root name is included",
        },
        matchesBeforeSourceTree: exported.dependencySourceTreeSha256 === beforeDependencySourceDigest,
        matchesBeforeOwnedTree: exported.dependencyOwnedTreeSha256 === beforeDependencyOwnedDigest,
      },
      beforeBuildInputComparison:
        "Dependency source/owned trees are checked against their exact recorded before hashes. Before complement evidence and limits are documented in device-auth-design-review.md; this artifact does not claim per-file before equality for complement inputs.",
      chromiumEvidence: "not included; this artifact is only the final static app export",
    };
    const provenancePath = context.pathInArtifacts(`mobile-device-auth-${candidateLabel}-web-export-provenance.json`);
    await writeFile(provenancePath, JSON.stringify(provenance, null, 2) + "\n", { mode: 0o600 });
    const manifestBytes = await readFile(exported.bundleManifestPath);
    await writeFile(join(exportRoot, `../mobile-web-export-${candidateLabel}-manifest.json`), manifestBytes, { mode: 0o600 });
    await writeFile(join(exportRoot, `../mobile-web-export-${candidateLabel}-provenance.json`), JSON.stringify(provenance, null, 2) + "\n", { mode: 0o600 });
    return {
      candidateDigest: metadata.sourceDigest,
      sourceTreeSha256: exported.sourceTreeSha256,
      dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
      dependencyMatchesBefore:
        exported.dependencySourceTreeSha256 === beforeDependencySourceDigest &&
        exported.dependencyOwnedTreeSha256 === beforeDependencyOwnedDigest,
      bundleSha256: copiedBundle.sha256,
      bundleFileCount: copiedBundle.files.length,
      bundlePath: exportRoot,
      provenancePath,
    };
  },
);
