import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const ROOTS = [
  { name: "mobile", destination: "apps/kcoder-studio/mobile" },
  { name: "studio-shared", destination: "apps/kcoder-studio/shared" },
];
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_ID = /^[a-f0-9]{40}$/;
const EXCLUDED_PATH = "apps/kcoder-studio/mobile/src/storage/device-secret-binding.test.ts";
const CONFIG_PATH = "apps/kcoder-studio/mobile/app.config.ts";
const ANCHOR = "    ...appJson.expo,\n";
const BASE_TOKEN = "/__kcoder_mobile_mount_v1__";
// Exact build-only overlay from the pinned matched-export source materializer.
const MOUNT_OVERLAY = [
  "    experiments: {",
  "      ...appJson.expo.experiments,",
  '      ...(process.env.KCODER_STUDIO_MOBILE_WEB_DEPLOY === "1"',
  `        ? { baseUrl: "${BASE_TOKEN}" } : {}),`,
  "    },", "",
].join("\n");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const hashJson = value => sha256(Buffer.from(JSON.stringify(value)));
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const gitBlobSha1 = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const comparableRoots = roots => roots.map(({ name, destination, sha256, fileCount }) => ({ name, destination, sha256, fileCount }));

// Exact shouldOmitSourceEntry/collectTree rules from mobile-web-export.mjs.
// Root/table digests below also detect algorithm drift.
function sourceExcluded(name) {
  if ([".expo", ".git", "dist", "node_modules"].includes(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  return /(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name);
}
function canonicalPath(path) {
  return typeof path === "string" && path.length <= 4096 && !/[\\\0]/.test(path)
    && path.split("/").every(part => part && part !== "." && part !== "..");
}

/**
 * Derive exact exporter inputs from trusted Git objects, never sourcesContent.
 * The caller pins/reads provenance and export manifest and owns Git materialization.
 * readGitBlobs receives unique object IDs and returns same-order Buffer objects;
 * it must read the pinned Git objects, not map content or an unverified live tree.
 */
export async function derivePinnedGitExportSourceEvidence({
  inventoryBytes, sourceProvenance: provenance, exportManifest: manifest,
  combinedProvenanceBytes, expectedCombinedProvenanceSha256, readGitBlobs,
}) {
  assert.ok(Buffer.isBuffer(inventoryBytes), "Git inventory bytes must be a Buffer");
  assert.ok(inventoryBytes.length <= 4 * 1024 * 1024, "Git inventory exceeds its bound");
  assert.equal(provenance?.status, "complete");
  assert.equal(manifest?.status, "complete");
  assert.match(provenance.candidateManifestSha256, SHA256);
  assert.equal(sha256(inventoryBytes), provenance.candidateManifestSha256, "Git inventory raw pin mismatch");
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.kind, "git-mobile-shared-source-inventory");
  assert.ok(Array.isArray(inventory.entries) && inventory.entries.length > 0 && inventory.entries.length <= 4096);
  assert.equal(inventory.candidateFiles, inventory.entries.length);
  assert.equal(provenance.candidateFiles, inventory.candidateFiles);
  assert.match(inventory.sourceCommit, GIT_ID);
  for (const tree of [inventory.gitTrees?.mobile, inventory.gitTrees?.shared]) assert.match(tree, GIT_ID);
  const origin = provenance.sourceOrigin;
  assert.equal(inventory.sourceCommit, origin?.commit);
  assert.deepEqual(inventory.gitTrees, origin.gitTrees);
  assert.equal(inventory.candidateFiles, origin.sourceFileCount);
  let previous = "";
  for (const entry of inventory.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ["mode", "objectId", "path"]);
    assert.ok(["100644", "100755"].includes(entry.mode), "Git source must be regular");
    assert.match(entry.objectId, GIT_ID);
    assert.ok(canonicalPath(entry.path), "Git inventory path must be canonical");
    assert.ok(ROOTS.some(root => entry.path.startsWith(root.destination + "/")), "Git source escaped approved roots");
    assert.ok(compareText(previous, entry.path) < 0, "Git source paths must be unique and sorted");
    previous = entry.path;
  }
  const candidateDigest = hashJson(inventory.entries.map(({ mode, objectId, path }) => ({ mode, objectId, path })));
  assert.equal(candidateDigest, inventory.candidateDigest, "Git logical inventory mismatch");
  assert.equal(candidateDigest, provenance.candidateDigest);
  assert.equal(candidateDigest, origin.sourceInventorySha256);

  assert.match(expectedCombinedProvenanceSha256, SHA256);
  assert.equal(expectedCombinedProvenanceSha256, origin.combinedProvenanceSha256, "combined provenance expected pin differs from trusted reference");
  assert.ok(Buffer.isBuffer(combinedProvenanceBytes) && combinedProvenanceBytes.length <= 4 * 1024 * 1024);
  assert.equal(sha256(combinedProvenanceBytes), expectedCombinedProvenanceSha256, "combined provenance raw pin mismatch");
  const combined = JSON.parse(combinedProvenanceBytes.toString("utf8"));
  assert.equal(combined.status, "matched-export-complete");
  const sources = combined.sources?.filter(source => source.label === origin.label);
  assert.equal(sources?.length, 1, "combined source label missing or ambiguous");
  const source = sources[0];
  assert.equal(source.commit, inventory.sourceCommit);
  assert.deepEqual(source.gitTrees, inventory.gitTrees);
  assert.equal(source.sourceInventorySha256, candidateDigest);
  assert.equal(source.sourceFileCount, inventory.candidateFiles);
  assert.equal(source.packageLockSha256, origin.packageLockSha256);
  assert.ok(Object.hasOwn(source, "mountOverlay"), "combined source must declare overlay or null");

  const roots = manifest.inputRoots;
  assert.ok(Array.isArray(roots));
  assert.deepEqual(roots.map(({ name, destination }) => ({ name, destination })), ROOTS);
  for (const root of roots) {
    assert.ok(canonicalPath(root.sourceRoot?.slice(1)) && root.sourceRoot.startsWith("/"), "historical root path is noncanonical");
    assert.match(root.sha256, SHA256);
    assert.ok(Number.isSafeInteger(root.fileCount) && root.fileCount > 0);
  }
  assert.deepEqual(comparableRoots(provenance.sourceRoots), comparableRoots(roots));
  assert.deepEqual(origin.oldRunContextInputRoots, roots);
  assert.deepEqual(manifest.inputRootsAfter, roots);
  assert.equal(manifest.sourceUnchanged, true);
  assert.equal(provenance.snapshotCopyMatchesSource, true);
  assert.equal(provenance.snapshotUnchangedDuringExport, true);

  const objectIds = [...new Set(inventory.entries.map(entry => entry.objectId))];
  assert.equal(typeof readGitBlobs, "function");
  const blobs = await readGitBlobs(Object.freeze(objectIds));
  assert.ok(Array.isArray(blobs) && blobs.length === objectIds.length, "Git blob batch is incomplete");
  const byId = new Map();
  let totalBytes = 0;
  for (let index = 0; index < blobs.length; index++) {
    const bytes = blobs[index];
    assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 16 * 1024 * 1024, "invalid/oversize Git blob");
    totalBytes += bytes.length;
    assert.ok(totalBytes <= 64 * 1024 * 1024, "Git blob batch exceeds its byte bound");
    assert.equal(gitBlobSha1(bytes), objectIds[index], "Git blob header/content SHA1 mismatch");
    byId.set(objectIds[index], Buffer.from(bytes));
  }
  const files = [], excludedPaths = [];
  let overlayApplied = false;
  for (const entry of inventory.entries) {
    const root = ROOTS.find(root => entry.path.startsWith(root.destination + "/"));
    const path = entry.path.slice(root.destination.length + 1);
    const parts = path.split("/");
    let bytes = byId.get(entry.objectId);
    if (entry.path === `${ROOTS[0].destination}/package-lock.json`) {
      assert.equal(sha256(bytes), origin.packageLockSha256, "Git package-lock differs from export input");
    }
    if (entry.path === CONFIG_PATH && source.mountOverlay !== null) {
      const overlay = source.mountOverlay;
      assert.equal(overlay.path, CONFIG_PATH);
      assert.equal(overlay.baseToken, BASE_TOKEN);
      assert.equal(sha256(bytes), overlay.baseFileSha256, "mount overlay base mismatch");
      assert.equal(sha256(Buffer.from(MOUNT_OVERLAY)), overlay.insertedBlockSha256, "mount overlay block mismatch");
      const text = bytes.toString("utf8");
      assert.equal(text.split(ANCHOR).length - 1, 1, "mount overlay anchor is not unique");
      bytes = Buffer.from(text.replace(ANCHOR, ANCHOR + MOUNT_OVERLAY));
      assert.equal(sha256(bytes), overlay.updatedFileSha256, "mount overlay output mismatch");
      overlayApplied = true;
    }
    if (parts.some(part => sourceExcluded(part))) excludedPaths.push(entry.path);
    else files.push({ root: root.name, path, size: bytes.length, sha256: sha256(bytes) });
  }
  assert.equal(overlayApplied, source.mountOverlay !== null, "declared mount overlay was not applied exactly once");
  assert.deepEqual(excludedPaths, [EXCLUDED_PATH], "export exclusions differ from the pinned adapter contract");
  const derivedRoots = roots.map(root => {
    const entries = files.filter(file => file.root === root.name).map(({ path, size, sha256 }) => ({ path, size, sha256 }));
    entries.sort((left, right) => left.path.localeCompare(right.path));
    return { name: root.name, destination: root.destination, sha256: hashJson(entries), fileCount: entries.length };
  });
  assert.deepEqual(derivedRoots, comparableRoots(roots), "derived Git exporter roots mismatch");
  const sourceTreeSha256 = hashJson(derivedRoots.map(({ name, destination, sha256 }) => ({ name, destination, sha256 })));
  for (const expected of [provenance.sourceTreeSha256, origin.builderSourceTreeSha256, manifest.sourceTreeSha256, manifest.sourceHashBefore, manifest.sourceHashAfter]) {
    assert.equal(sourceTreeSha256, expected, "derived exporter source tree mismatch");
  }
  assert.equal(files.length, provenance.sourceCompleteness?.builderInputFileCount);
  return {
    sourceRoots: roots.map(root => ({ ...root })), files,
    verificationMetadata: { inventoryRawSha256: sha256(inventoryBytes), candidateDigest, sourceTreeSha256,
      gitFileCount: inventory.entries.length, exportFileCount: files.length, excludedPaths, overlayApplied, uniqueGitBlobCount: objectIds.length, verifiedGitBlobBytes: totalBytes },
  };
}
