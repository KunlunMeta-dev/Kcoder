import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

async function assertDisjointCopyRoots(source, destination) {
  assert.ok(typeof source === 'string' && source.trim() && typeof destination === 'string' && destination.trim(),
    'frozen copy requires explicit nonempty roots');
  const sourcePath = await realpath(resolve(source));
  let ancestor = resolve(destination);
  const missing = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  const targetPath = resolve(ancestor, ...missing);
  const nested = (parent, child) => {
    const path = relative(parent, child);
    return !path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  assert.ok(!nested(sourcePath, targetPath) && !nested(targetPath, sourcePath), 'frozen copy roots must not overlap');
}

export async function copyVerifiedSnapshot({ sourceRoot, destination, expectedDigest, expectedCount }) {
  await assertDisjointCopyRoots(sourceRoot, destination);
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
