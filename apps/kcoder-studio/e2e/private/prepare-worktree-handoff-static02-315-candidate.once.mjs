// Build a read-only 315-file source candidate from the pinned historical
// declared manifest plus the single reviewed New.tsx static-02 overlay.
// This prepares source inputs only; it does not run Expo, Gateway, or Browser.
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
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { repoRoot } from "../harness/run-context.mjs";

const BASE_ROOT = resolve(
  repoRoot,
  "target/private-phone-ux-implementation/mobile-web-export-durable-task-handoff-static02-20261008",
);
const BASE_SOURCE_ROOT = resolve(BASE_ROOT, "source");
const BASE_MANIFEST_PATH = resolve(BASE_ROOT, "source-files.json");
const BASE_METADATA_PATH = resolve(BASE_ROOT, "metadata.json");
const STATIC02_ROOT = resolve(repoRoot, "target/worktree-handoff-discovery-20261008/static-02");
const STATIC02_MANIFEST_PATH = resolve(STATIC02_ROOT, "manifest.json");
const STATIC02_DIFF_PATH = resolve(STATIC02_ROOT, "products.diff");
const OUTPUT_ROOT = resolve(
  repoRoot,
  "target/private-phone-ux-implementation/worktree-handoff-discovery-static02-20261008",
);
const EXPECTED_BASE_MANIFEST_SHA256 = "4b3b654f3dfe71a277a90422fa50a082ae05fb4947e697c4e5c7f57c3246c780";
const EXPECTED_BASE_METADATA_SHA256 = "0286ded13b939229b764f192d8fd783d2ccdc900e33f8a934765c9d74f4b3406";
const EXPECTED_BASE_SOURCE_DIGEST = "8623b4e873e21303b40ea1f04b7107fd67a54f746ac328515542bf6ffee79892";
const EXPECTED_STATIC02_MANIFEST_SHA256 = "51c36f401fc6addc93610f0c5c690103e4aa397865329e713011dd2e82f2df5e";
const EXPECTED_STATIC02_SOURCE_SHA256 = "a8aa57b0fc3071c01cd0e48276ddc54fb2bd48b189dba492eeb6aa6666574b7a";
const EXPECTED_STATIC02_DIFF_SHA256 = "e572050ab7393f6d6787659bb8822c07d03d52ea8f1f99c2f545c7c0ae89296c";
const EXPECTED_BASE_NEW_SHA256 = "dcbc986532e34a0606351166461cf83300357f934d141d2b8f5d9764a15a961b";
const EXPECTED_RAW_ONLY_PATH = "apps/kcoder-studio/mobile/src/storage/device-secret-binding.test.ts";
const EXPECTED_RAW_ONLY_SHA256 = "19f3f7da815c6cf23460f30f37bfa722abc8561e9d5c28c2b4fe6a4a4d2af45b";
const EXPECTED_CANDIDATE_COUNT = 315;
const NEW_SOURCE_PATH = "apps/kcoder-studio/mobile/src/app/new.tsx";
const BASE_COMMIT = "09d1e88342909b36237a571774d2987fa2a8556c";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rootInventory(files, destination) {
  const prefix = `${destination}/`;
  const entries = [...files.entries()]
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, file]) => ({ path: path.slice(prefix.length), size: file.size, sha256: file.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return { sha256: sha256(Buffer.from(JSON.stringify(entries))), fileCount: entries.length };
}

function candidateSourceDigest(files) {
  const roots = [
    { name: "mobile", destination: "apps/kcoder-studio/mobile", ...rootInventory(files, "apps/kcoder-studio/mobile") },
    { name: "studio-shared", destination: "apps/kcoder-studio/shared", ...rootInventory(files, "apps/kcoder-studio/shared") },
  ];
  return sha256(Buffer.from(JSON.stringify(roots.map(({ name, destination, sha256: treeSha256 }) => ({
    name,
    destination,
    sha256: treeSha256,
  })))));
}

function assertSafeRelativePath(path) {
  assert.ok(typeof path === "string" && path.length > 0, "manifest path must be nonempty");
  assert.ok(!path.startsWith("/") && !path.includes("\\"), `manifest path must be POSIX relative: ${path}`);
  assert.ok(!path.split("/").some(part => part === "" || part === "." || part === ".."), `manifest path escapes candidate: ${path}`);
}

async function readRegular(path, label, { readOnly = false } = {}) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  if (readOnly) assert.equal(info.mode & 0o222, 0, `${label} must be read-only`);
  return readFile(path);
}

async function assertCanonicalDirectory(path, label, mode) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a real directory`);
  assert.equal(await realpath(path), path, `${label} must not traverse a symlink`);
  if (mode !== undefined) assert.equal(info.mode & 0o777, mode, `${label} permissions changed`);
  return info;
}

async function collectPhysicalTree(root) {
  const files = new Map();
  async function visit(directory, relativeDirectory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => codepointCompare(left.name, right.name));
    for (const child of children) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const absolutePath = join(directory, child.name);
      const info = await lstat(absolutePath);
      assert.ok(!info.isSymbolicLink(), `source tree contains a symlink: ${relativePath}`);
      if (info.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (info.isFile()) {
        const bytes = await readFile(absolutePath);
        files.set(relativePath, { size: bytes.length, sha256: sha256(bytes), bytes });
      } else {
        assert.fail(`source tree contains a special file: ${relativePath}`);
      }
    }
  }
  await visit(root, "");
  return files;
}

async function writeReadonlyExclusive(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o400);
}

async function freezeDirectories(root) {
  const children = await readdir(root, { withFileTypes: true });
  for (const child of children) {
    if (child.isDirectory()) await freezeDirectories(join(root, child.name));
  }
  await chmod(root, 0o555);
}

async function assertAbsent(path, label) {
  await lstat(path).then(() => assert.fail(`${label} already exists; refusing overwrite`), error => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function main() {
  assert.equal(repoRoot, resolve(repoRoot), "integration repo root must be canonical");
  await assertCanonicalDirectory(BASE_ROOT, "old declared-315 source root");
  await assertCanonicalDirectory(BASE_SOURCE_ROOT, "old declared-315 source tree", 0o555);
  await assertCanonicalDirectory(STATIC02_ROOT, "reviewed static-02 overlay root");
  const outputParent = dirname(OUTPUT_ROOT);
  await assertCanonicalDirectory(outputParent, "private candidate parent");
  assert.equal((await lstat(outputParent)).mode & 0o077, 0, "private candidate parent must be owner-only");
  await assertAbsent(OUTPUT_ROOT, "new static-02 candidate");

  const [baseManifestBytes, baseMetadataBytes, staticManifestBytes, diffBytes] = await Promise.all([
    readRegular(BASE_MANIFEST_PATH, "old declared-315 source manifest", { readOnly: true }),
    readRegular(BASE_METADATA_PATH, "old declared-315 source metadata", { readOnly: true }),
    readRegular(STATIC02_MANIFEST_PATH, "static-02 overlay manifest"),
    readRegular(STATIC02_DIFF_PATH, "static-02 product diff"),
  ]);
  assert.equal(sha256(baseManifestBytes), EXPECTED_BASE_MANIFEST_SHA256, "old declared-315 source manifest pin changed");
  assert.equal(sha256(baseMetadataBytes), EXPECTED_BASE_METADATA_SHA256, "old declared-315 source metadata pin changed");
  assert.equal(sha256(staticManifestBytes), EXPECTED_STATIC02_MANIFEST_SHA256, "static-02 manifest pin changed");
  assert.equal(sha256(diffBytes), EXPECTED_STATIC02_DIFF_SHA256, "static-02 diff pin changed");

  const baseManifest = JSON.parse(baseManifestBytes.toString("utf8"));
  const baseMetadata = JSON.parse(baseMetadataBytes.toString("utf8"));
  const overlayManifest = JSON.parse(staticManifestBytes.toString("utf8"));
  assert.equal(baseManifest.count, EXPECTED_CANDIDATE_COUNT);
  assert.equal(baseManifest.sourceDigest, EXPECTED_BASE_SOURCE_DIGEST);
  assert.equal(baseManifest.files.length, EXPECTED_CANDIDATE_COUNT);
  assert.equal(baseMetadata.sourceDigest, EXPECTED_BASE_SOURCE_DIGEST);
  assert.equal(baseMetadata.exportSourceFileCount, EXPECTED_CANDIDATE_COUNT);
  assert.equal(baseMetadata.baseCommit, BASE_COMMIT);
  assert.deepEqual(baseManifest.roots.map(({ name, destination, fileCount }) => ({ name, destination, fileCount })), [
    { name: "mobile", destination: "apps/kcoder-studio/mobile", fileCount: 296 },
    { name: "studio-shared", destination: "apps/kcoder-studio/shared", fileCount: 19 },
  ]);
  assert.deepEqual(baseManifest.excludedByExportFilter, [
    { path: EXPECTED_RAW_ONLY_PATH, kind: "file", filter: "same as mobile-web-export.mjs source filter" },
  ]);
  assert.equal(overlayManifest.status, "STATIC_ONLY_NOT_RUN");
  assert.equal(overlayManifest.files.length, 1);
  assert.equal(overlayManifest.files[0].path, NEW_SOURCE_PATH);
  assert.equal(overlayManifest.files[0].bytes, 49_013);
  assert.equal(overlayManifest.files[0].sha256, EXPECTED_STATIC02_SOURCE_SHA256);

  const declaredEntries = new Map();
  for (const entry of baseManifest.files) {
    assertSafeRelativePath(entry.path);
    assert.ok(!declaredEntries.has(entry.path), `duplicate declared-315 path: ${entry.path}`);
    declaredEntries.set(entry.path, entry);
  }
  const rawTree = await collectPhysicalTree(BASE_SOURCE_ROOT);
  assert.equal(rawTree.size, 316, "old frozen physical tree no longer has the recorded 316-file shape");
  const rawOnly = [...rawTree.entries()].filter(([path]) => !declaredEntries.has(path));
  assert.deepEqual(rawOnly.map(([path, file]) => ({ path, size: file.size, sha256: file.sha256 })), [
    { path: EXPECTED_RAW_ONLY_PATH, size: 1855, sha256: EXPECTED_RAW_ONLY_SHA256 },
  ], "raw-only exclusion differs from the recorded boundary");

  const candidateFiles = new Map();
  for (const entry of baseManifest.files) {
    const actual = rawTree.get(entry.path);
    assert.ok(actual, `declared-315 file is absent from the frozen source: ${entry.path}`);
    assert.equal(actual.size, entry.size, `base source size differs: ${entry.path}`);
    assert.equal(actual.sha256, entry.sha256, `base source hash differs: ${entry.path}`);
    candidateFiles.set(entry.path, actual);
  }
  assert.equal(candidateSourceDigest(candidateFiles), EXPECTED_BASE_SOURCE_DIGEST, "old declared-315 source digest does not reproduce");
  assert.equal(candidateFiles.get(NEW_SOURCE_PATH).sha256, EXPECTED_BASE_NEW_SHA256, "New.tsx base pin changed");

  const overlaySourcePath = resolve(STATIC02_ROOT, "sources", NEW_SOURCE_PATH);
  const overlayBytes = await readRegular(overlaySourcePath, "static-02 New.tsx overlay");
  assert.equal(sha256(overlayBytes), EXPECTED_STATIC02_SOURCE_SHA256);
  assert.equal(overlayBytes.length, overlayManifest.files[0].bytes);
  const originalBeforePath = resolve(repoRoot, "target/worktree-handoff-discovery-20261008/before/new.tsx");
  assert.equal(sha256(await readRegular(originalBeforePath, "original handoff baseline New.tsx")), EXPECTED_BASE_NEW_SHA256);

  candidateFiles.set(NEW_SOURCE_PATH, {
    size: overlayBytes.length,
    sha256: EXPECTED_STATIC02_SOURCE_SHA256,
    bytes: overlayBytes,
  });
  const candidateDigest = candidateSourceDigest(candidateFiles);
  const candidateEntries = [...candidateFiles.entries()]
    .map(([path, file]) => ({ path, size: file.size, sha256: file.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const mobileInventory = rootInventory(candidateFiles, "apps/kcoder-studio/mobile");
  const sharedInventory = rootInventory(candidateFiles, "apps/kcoder-studio/shared");
  assert.equal(candidateEntries.length, EXPECTED_CANDIDATE_COUNT);
  assert.equal(mobileInventory.fileCount, 296);
  assert.equal(sharedInventory.fileCount, 19);

  let outputCreated = false;
  try {
    await mkdir(OUTPUT_ROOT, { recursive: false, mode: 0o700 });
    outputCreated = true;
    const candidateSourceRoot = resolve(OUTPUT_ROOT, "source");
    await mkdir(candidateSourceRoot, { recursive: false, mode: 0o700 });

    for (const [path, file] of [...candidateFiles.entries()].sort(([left], [right]) => codepointCompare(left, right))) {
      const outputPath = resolve(candidateSourceRoot, path);
      assert.ok(outputPath.startsWith(`${candidateSourceRoot}${sep}`), `candidate output escaped source root: ${path}`);
      await writeReadonlyExclusive(outputPath, file.bytes);
    }
    await freezeDirectories(candidateSourceRoot);

    const sourceFiles = {
      status: "FROZEN_SOURCE_INPUTS_NOT_EXPORTED",
      filter: baseManifest.filter,
      count: EXPECTED_CANDIDATE_COUNT,
      sourceDigest: candidateDigest,
      roots: [
        { name: "mobile", destination: "apps/kcoder-studio/mobile", ...mobileInventory },
        { name: "studio-shared", destination: "apps/kcoder-studio/shared", ...sharedInventory },
      ],
      files: candidateEntries,
      excludedByExportFilter: baseManifest.excludedByExportFilter,
    };
    const sourceFilesBytes = Buffer.from(`${JSON.stringify(sourceFiles, null, 2)}\n`);
    const shaMap = Object.fromEntries(candidateEntries.map(({ path, sha256: fileSha }) => [path, fileSha]));
    const shaMapBytes = Buffer.from(`${JSON.stringify(shaMap, null, 2)}\n`);
    const freeze = {
      sourceDigest: candidateDigest,
      count: EXPECTED_CANDIDATE_COUNT,
      sourceDigestEncoding: "sha256 of JSON.stringify([{name,destination,sha256},...]); each root SHA hashes JSON.stringify of path-sorted {path,size,sha256} entries",
    };
    const freezeBytes = Buffer.from(`${JSON.stringify(freeze, null, 2)}\n`);
    const candidateManifest = {
      schemaVersion: 1,
      status: "FROZEN_SOURCE_CANDIDATE_NOT_EXPORTED",
      sourceDigest: candidateDigest,
      sourceDigestEncoding: freeze.sourceDigestEncoding,
      fileCount: EXPECTED_CANDIDATE_COUNT,
      roots: sourceFiles.roots,
      files: candidateEntries,
      base: {
        candidateRoot: BASE_ROOT,
        sourceRoot: BASE_SOURCE_ROOT,
        commit: BASE_COMMIT,
        declaredFileCount: EXPECTED_CANDIDATE_COUNT,
        physicalRawFileCount: 316,
        declaredManifestPath: relative(repoRoot, BASE_MANIFEST_PATH).split(sep).join("/"),
        declaredManifestSha256: EXPECTED_BASE_MANIFEST_SHA256,
        sourceDigest: EXPECTED_BASE_SOURCE_DIGEST,
        excludedRawFiles: rawOnly.map(([path, file]) => ({ path, size: file.size, sha256: file.sha256 })),
      },
      overlay: {
        kind: "single-file replacement",
        manifestPath: relative(repoRoot, STATIC02_MANIFEST_PATH).split(sep).join("/"),
        manifestSha256: EXPECTED_STATIC02_MANIFEST_SHA256,
        diffPath: relative(repoRoot, STATIC02_DIFF_PATH).split(sep).join("/"),
        diffSha256: EXPECTED_STATIC02_DIFF_SHA256,
        fileCount: 1,
        files: [{
          path: NEW_SOURCE_PATH,
          action: "replace",
          beforeSha256: EXPECTED_BASE_NEW_SHA256,
          afterSha256: EXPECTED_STATIC02_SOURCE_SHA256,
          size: overlayBytes.length,
        }],
      },
    };
    const candidateManifestBytes = Buffer.from(`${JSON.stringify(candidateManifest, null, 2)}\n`);
    const metadata = {
      schemaVersion: 1,
      status: "FROZEN_SOURCE_INPUTS_NOT_EXPORTED",
      purpose: "worktree handoff CTA correction, reviewed static-02 New.tsx only",
      baseCommit: BASE_COMMIT,
      base: candidateManifest.base,
      overlay: candidateManifest.overlay,
      sourceRoot: "source",
      sourceFiles: EXPECTED_CANDIDATE_COUNT,
      sourceDigest: candidateDigest,
      sourceDigestEncoding: freeze.sourceDigestEncoding,
      sourceManifestPath: "source-files.json",
      sourceManifestSha256: sha256(sourceFilesBytes),
      sha256MapPath: "sha256.json",
      sha256MapSha256: sha256(shaMapBytes),
      candidateManifestPath: "candidate-manifest.json",
      candidateManifestSha256: sha256(candidateManifestBytes),
      packageJsonSha256: candidateFiles.get("apps/kcoder-studio/mobile/package.json").sha256,
      packageLockSha256: candidateFiles.get("apps/kcoder-studio/mobile/package-lock.json").sha256,
      mobileFiles: mobileInventory.fileCount,
      sharedFiles: sharedInventory.fileCount,
      exportStatus: "not-run",
      browserStatus: "not-run",
    };

    await writeReadonlyExclusive(resolve(OUTPUT_ROOT, "source-files.json"), sourceFilesBytes);
    await writeReadonlyExclusive(resolve(OUTPUT_ROOT, "sha256.json"), shaMapBytes);
    await writeReadonlyExclusive(resolve(OUTPUT_ROOT, "freeze.json"), freezeBytes);
    await writeReadonlyExclusive(resolve(OUTPUT_ROOT, "candidate-manifest.json"), candidateManifestBytes);
    const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
    await writeReadonlyExclusive(resolve(OUTPUT_ROOT, "metadata.json"), metadataBytes);
    await writeReadonlyExclusive(resolve(OUTPUT_ROOT, "overlay.diff"), diffBytes);
    await freezeDirectories(OUTPUT_ROOT);

    const copiedSource = await collectPhysicalTree(candidateSourceRoot);
    assert.equal(copiedSource.size, EXPECTED_CANDIDATE_COUNT);
    assert.equal(candidateSourceDigest(copiedSource), candidateDigest, "copied source candidate digest differs");
    for (const entry of candidateEntries) {
      const actual = copiedSource.get(entry.path);
      assert.ok(actual, `copied source file is missing: ${entry.path}`);
      assert.equal(actual.size, entry.size, `copied source file size differs: ${entry.path}`);
      assert.equal(actual.sha256, entry.sha256, `copied source file digest differs: ${entry.path}`);
    }

    return {
      status: metadata.status,
      candidateRoot: OUTPUT_ROOT,
      candidateSourceRoot,
      candidateFiles: EXPECTED_CANDIDATE_COUNT,
      sourceDigest: candidateDigest,
      sourceManifestSha256: metadata.sourceManifestSha256,
      candidateManifestSha256: metadata.candidateManifestSha256,
      metadataSha256: sha256(metadataBytes),
      overlayPath: NEW_SOURCE_PATH,
      overlaySha256: EXPECTED_STATIC02_SOURCE_SHA256,
      baseNewSha256: EXPECTED_BASE_NEW_SHA256,
      baseDeclaredFiles: EXPECTED_CANDIDATE_COUNT,
      basePhysicalFiles: rawTree.size,
      excludedRawFiles: rawOnly.map(([path, file]) => ({ path, size: file.size, sha256: file.sha256 })),
      mobileFiles: mobileInventory.fileCount,
      sharedFiles: sharedInventory.fileCount,
      exportStatus: "not-run",
      browserStatus: "not-run",
    };
  } catch (error) {
    if (outputCreated) await rm(OUTPUT_ROOT, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

main().then(result => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch(error => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
});
