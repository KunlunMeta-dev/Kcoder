import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { verifySourceMapBundleEvidence } from "./render-profile-attribution-contract.mjs";

export async function assertPathWithinApprovedRoots(candidatePath, approvedRoots, label) {
  const candidate = resolve(candidatePath);
  const candidateInfo = await lstat(candidate);
  assert.ok(!candidateInfo.isSymbolicLink(), `${label} cannot be a symbolic link`);
  const candidateCanonical = await realpath(candidate);

  for (const approvedRoot of approvedRoots) {
    const root = resolve(approvedRoot);
    const rootInfo = await lstat(root);
    assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), `${label} approved root must be a real directory`);
    const rootCanonical = await realpath(root);
    assert.equal(rootCanonical, root, `${label} approved root must have a canonical path without symlink ancestors`);
    const pathFromRoot = relative(rootCanonical, candidateCanonical);
    if (pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))) {
      return candidateCanonical;
    }
  }

  assert.fail(`${label} canonical path is outside every approved evidence root`);
}

export function verifyMobileExportManifestEnvelope(manifest, manifestBytes, expectedManifestSha256, label) {
  assert.equal(sha256(manifestBytes), expectedManifestSha256, `${label} export manifest changed after its digest was read`);
  assert.equal(manifest.status, "complete", `${label} Mobile Web export must be complete`);
  assert.ok(Array.isArray(manifest.bundleFiles), `${label} export bundle inventory is required`);
  const sourceMapsEnabled = manifest.sourceMapEvidence !== undefined;
  const sourceMapFiles = manifest.bundleFiles.filter((entry) => typeof entry?.path === "string" && entry.path.endsWith(".map"));
  if (sourceMapsEnabled) {
    verifySourceMapBundleEvidence(manifest.sourceMapEvidence, manifest);
    assert.equal(manifest.bundleFileCount, 37 + sourceMapFiles.length, `${label} source-map export must contain the standard files plus the recorded maps`);
  } else {
    assert.equal(manifest.bundleFileCount, 37, `${label} export must contain exactly 37 public files`);
    assert.equal(sourceMapFiles.length, 0, `${label} default Mobile Web export must not contain unrecorded source maps`);
  }
  assert.equal(manifest.bundleFiles.length, manifest.bundleFileCount, `${label} export must list every public file`);
  assert.equal(sha256(Buffer.from(JSON.stringify(manifest.bundleFiles))), manifest.bundleSha256, `${label} bundle table aggregate digest is invalid`);

  const names = new Set();
  let totalBytes = 0;
  for (const entry of manifest.bundleFiles) {
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), `${label} bundle entry must be an object`);
    assert.deepEqual(Object.keys(entry), ["path", "size", "sha256"], `${label} bundle entry must have only path, size, and digest`);
    assertSafeBundlePath(entry.path, label);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0, `${label} bundle entry size is invalid`);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, `${label} bundle entry digest is invalid`);
    assert.ok(!names.has(entry.path), `${label} bundle manifest contains duplicate paths`);
    names.add(entry.path);
    totalBytes += entry.size;
    assert.ok(totalBytes <= 64 * 1024 * 1024, `${label} public bundle exceeds the 64 MiB fixture limit`);
  }

  const indexEntry = manifest.bundleFiles.find((entry) => entry.path === "index.html");
  assert.ok(indexEntry, `${label} export must include root index.html`);
  assert.equal(indexEntry.sha256, manifest.indexHtmlSha256, `${label} index digest does not match its bundle entry`);
}

export async function readVerifiedMobileExportFile(bundleRoot, entry, label) {
  const parts = assertSafeBundlePath(entry.path, label);
  let current = resolve(bundleRoot);
  for (const part of parts) {
    current = resolve(current, part);
    const info = await lstat(current);
    assert.ok(!info.isSymbolicLink(), `${label} bundle path cannot contain symlinks`);
  }

  const info = await lstat(current);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} bundle asset must be a regular file`);
  assert.equal(info.size, entry.size, `${label} bundle asset size does not match the export manifest`);
  const bytes = await readFile(current);
  assert.equal(sha256(bytes), entry.sha256, `${label} bundle asset digest does not match the export manifest`);
  return bytes;
}

function assertSafeBundlePath(value, label) {
  assert.ok(typeof value === "string" && value.length > 0, `${label} bundle path must be a non-empty string`);
  assert.ok(!value.includes("\\") && !value.startsWith("/") && !/^[a-zA-Z]:/.test(value), `${label} bundle path must be a normalized relative path`);
  const parts = value.split("/");
  assert.ok(parts.every((part) => part && part !== "." && part !== ".."), `${label} bundle path cannot contain empty or traversal segments`);
  return parts;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
