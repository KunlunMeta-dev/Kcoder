import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export async function copyVerifiedSnapshot({ sourceRoot, destination, expectedDigest, expectedCount }) {
  const root = resolve(sourceRoot);
  const targetRoot = resolve(destination);
  const freeze = JSON.parse(await readFile(resolve(root, "freeze.json"), "utf8").catch(async error => {
    if (error.code !== "ENOENT") throw error;
    return readFile(resolve(root, "metadata.json"), "utf8");
  }));
  const hashes = JSON.parse(await readFile(resolve(root, "sha256.json"), "utf8"));
  if (freeze.status !== undefined) assert.equal(freeze.status, "auth candidate; unit/syntax only; full-chain E2E pending");
  assert.equal(freeze.sourceDigest, expectedDigest);
  assert.equal(freeze.count ?? freeze.files, expectedCount);
  assert.equal(Object.keys(hashes).length, expectedCount);

  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  for (const [relativePath, expectedHash] of Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right))) {
    assert.ok(!relativePath.startsWith("/") && !relativePath.split(/[\\/]/).includes(".."), "frozen path must stay inside its source root");
    const source = resolve(root, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    assert.ok(destinationPath.startsWith(`${targetRoot}${sep}`), "frozen destination escaped its run state");
    const sourceInfo = await lstat(source);
    assert.ok(sourceInfo.isFile() && !sourceInfo.isSymbolicLink(), `frozen source must be a regular file: ${relativePath}`);
    const sourceBytes = await readFile(source);
    assert.equal(sha256(sourceBytes), expectedHash, `frozen source hash changed: ${relativePath}`);
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await copyFile(source, destinationPath);
    assert.equal(sha256(await readFile(destinationPath)), expectedHash, `frozen copy hash changed: ${relativePath}`);
  }

  return { sourceDigest: freeze.sourceDigest, fileCount: freeze.count, status: "verified-copy" };
}

export async function copyFrozenMobileWeb({
  sourceRoot,
  destination,
  expectedBundleSha256,
  manifestPath = resolve(dirname(resolve(sourceRoot)), "mobile-web-export-mobile-high-latency-before-manifest.json"),
  expectedSourceTreeSha256,
  expectedDependencySourceTreeSha256,
  expectedDependencyOwnedTreeSha256,
}) {
  const source = resolve(sourceRoot);
  const destinationRoot = resolve(destination);
  const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.sourceUnchanged, true);
  assert.equal(manifest.snapshotCopyMatchesSource, true);
  assert.equal(manifest.snapshotUnchangedDuringExport, true);
  assert.equal(manifest.terminalHookChangesOnlyGeneratedHtml, true);
  assert.equal(manifest.bundleSha256, expectedBundleSha256);
  if (expectedSourceTreeSha256 !== undefined) assert.equal(manifest.sourceTreeSha256, expectedSourceTreeSha256);
  if (expectedDependencySourceTreeSha256 !== undefined) {
    assert.equal(manifest.dependencyProvenance?.sourceTreeSha256Before, expectedDependencySourceTreeSha256);
    assert.equal(manifest.dependencyProvenance?.sourceTreeSha256After, expectedDependencySourceTreeSha256);
    assert.equal(manifest.dependencyProvenance?.sourceUnchanged, true);
  }
  if (expectedDependencyOwnedTreeSha256 !== undefined) {
    assert.equal(manifest.dependencyProvenance?.copiedTreeSha256, expectedDependencyOwnedTreeSha256);
    assert.equal(manifest.dependencyProvenance?.copiedSymlinks, false);
  }
  const sourceFiles = await collectRegularFiles(source);
  assert.deepEqual(sourceFiles, manifest.bundleFiles);
  assert.equal(hashJson(sourceFiles), manifest.bundleSha256);

  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  await copyRegularTree(source, destinationRoot);
  const copiedFiles = await collectRegularFiles(destinationRoot);
  assert.deepEqual(copiedFiles, manifest.bundleFiles);
  assert.equal(hashJson(copiedFiles), manifest.bundleSha256);
  return {
    bundleSha256: manifest.bundleSha256,
    fileCount: manifest.bundleFileCount,
    sourceTreeSha256: manifest.sourceTreeSha256,
    dependencySourceTreeSha256: manifest.dependencyProvenance?.sourceTreeSha256Before ?? null,
    dependencyOwnedTreeSha256: manifest.dependencyProvenance?.copiedTreeSha256 ?? null,
    status: "verified-copy",
  };
}

async function copyRegularTree(source, destination) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name);
    const to = resolve(destination, entry.name);
    const info = await lstat(from);
    assert.ok(!info.isSymbolicLink(), `Mobile Web export cannot contain a symlink: ${entry.name}`);
    if (info.isDirectory()) {
      await mkdir(to, { recursive: false, mode: 0o700 });
      await copyRegularTree(from, to);
    } else {
      assert.ok(info.isFile(), `Mobile Web export must contain regular files: ${entry.name}`);
      await copyFile(from, to);
    }
  }
}

async function collectRegularFiles(root) {
  const entries = [];
  async function visit(directory) {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, child.name);
      const relativePath = path.slice(root.length + 1).split("\\").join("/");
      const info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), `Mobile Web bundle cannot contain a symlink: ${relativePath}`);
      if (info.isDirectory()) await visit(path);
      else {
        assert.ok(info.isFile(), `Mobile Web bundle must contain regular files: ${relativePath}`);
        const bytes = await readFile(path);
        entries.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

function hashJson(value) {
  return createHash("sha256").update(Buffer.from(JSON.stringify(value))).digest("hex");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
