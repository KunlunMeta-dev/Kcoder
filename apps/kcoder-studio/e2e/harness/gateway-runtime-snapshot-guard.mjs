import assert from "node:assert/strict";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export async function resolveExistingPrivateGatewaySnapshot(repoRoot, requestedPath) {
  const snapshotRoot = await resolveExistingPrivatePath(repoRoot, requestedPath);
  const manifestPath = resolve(snapshotRoot, "gateway-runtime-freeze.json");
  const manifestInfo = await lstat(manifestPath);
  assert.ok(manifestInfo.isFile() && !manifestInfo.isSymbolicLink(), "private Gateway runtime freeze manifest must be a regular file");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest?.status, "complete", "private Gateway runtime freeze manifest must be complete");
  assert.ok(Array.isArray(manifest.sourceFiles), "private Gateway runtime freeze manifest must list source files");
  assert.ok(Array.isArray(manifest.dependencyFiles), "private Gateway runtime freeze manifest must list dependency files");
  assert.equal(typeof manifest.sourceTreeSha256, "string", "private Gateway runtime freeze manifest must include the source tree digest");
  assert.equal(typeof manifest.dependencyTreeSha256, "string", "private Gateway runtime freeze manifest must include the dependency tree digest");

  return { snapshotRoot, manifestPath, manifest };
}

export async function resolveExistingPrivatePath(repoRoot, requestedPath) {
  const canonicalRepoRoot = await realpath(repoRoot);
  const privateRootPath = resolve(canonicalRepoRoot, "target/private-phone-ux-implementation");
  const requestedRoot = resolve(canonicalRepoRoot, requestedPath);
  assert.ok(
    isWithin(privateRootPath, requestedRoot, false),
    "explicit private Gateway runtime must be below target/private-phone-ux-implementation",
  );

  const privateRoot = await realpath(privateRootPath);
  const canonicalPath = await realpath(requestedRoot);
  assert.ok(
    isWithin(privateRoot, canonicalPath, false),
    "private input canonical path escapes target/private-phone-ux-implementation",
  );
  return canonicalPath;
}

function isWithin(root, candidate, allowEqual) {
  const path = relative(root, candidate);
  if (path === "") return allowEqual;
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}
