import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { derivePinnedGitExportSourceEvidence } from "./render-profile-git-source-evidence.mjs";
import { resolvePinnedMetroSourcePath } from "./render-profile-attribution-contract.mjs";

const MOBILE = "apps/kcoder-studio/mobile";
const SHARED = "apps/kcoder-studio/shared";
const CONFIG = `${MOBILE}/app.config.ts`;
const EXCLUDED = `${MOBILE}/src/storage/device-secret-binding.test.ts`;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hashJson = value => sha(Buffer.from(JSON.stringify(value)));
const blobId = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const BLOCK = '    experiments: {\n      ...appJson.expo.experiments,\n      ...(process.env.KCODER_STUDIO_MOBILE_WEB_DEPLOY === "1"\n        ? { baseUrl: "/__kcoder_mobile_mount_v1__" } : {}),\n    },\n';

function fixture({ overlay = false, extraExcluded = false } = {}) {
  const content = new Map([
    [CONFIG, Buffer.from("export default {\n    ...appJson.expo,\n};\n")],
    [`${MOBILE}/package-lock.json`, Buffer.from('{"lockfileVersion":3}\n')],
    [`${MOBILE}/src/runtime/sample.ts`, Buffer.from("export const value = 1;\n")],
    [EXCLUDED, Buffer.from("// intentionally excluded by the exporter\n")],
    [`${SHARED}/badge.ts`, Buffer.from("export const badge = 2;\n")],
  ]);
  if (extraExcluded) content.set(`${MOBILE}/src/credential-extra.ts`, Buffer.from("// unexpected additional exclusion\n"));
  const entries = [...content].map(([path, bytes]) => ({ mode: "100644", objectId: blobId(bytes), path }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const inventory = { schemaVersion: 1, kind: "git-mobile-shared-source-inventory", sourceCommit: "1".repeat(40),
    gitTrees: { mobile: "2".repeat(40), shared: "3".repeat(40) }, candidateFiles: entries.length,
    candidateDigest: hashJson(entries), entries };
  const updatedConfig = Buffer.from(content.get(CONFIG).toString().replace("    ...appJson.expo,\n", "    ...appJson.expo,\n" + BLOCK));
  const expectedFiles = [...content].filter(([path]) => path !== EXCLUDED && path !== `${MOBILE}/src/credential-extra.ts`).map(([path, original]) => {
    const bytes = overlay && path === CONFIG ? updatedConfig : original;
    const destination = path.startsWith(MOBILE + "/") ? MOBILE : SHARED;
    return { root: destination === MOBILE ? "mobile" : "studio-shared", path: path.slice(destination.length + 1), size: bytes.length, sha256: sha(bytes) };
  });
  const roots = [{ name: "mobile", destination: MOBILE }, { name: "studio-shared", destination: SHARED }].map(root => {
    const rows = expectedFiles.filter(file => file.root === root.name).map(({ path, size, sha256 }) => ({ path, size, sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return { ...root, sourceRoot: `/already-removed/${root.destination}`, sha256: hashJson(rows), fileCount: rows.length };
  });
  const sourceTreeSha256 = hashJson(roots.map(({ name, destination, sha256 }) => ({ name, destination, sha256 })));
  const source = { label: overlay ? "before-10feb" : "comparison-9925461c", commit: inventory.sourceCommit,
    gitTrees: inventory.gitTrees, sourceInventorySha256: inventory.candidateDigest, sourceFileCount: entries.length,
    packageLockSha256: sha(content.get(`${MOBILE}/package-lock.json`)), mountOverlay: overlay ? {
      path: CONFIG, baseToken: "/__kcoder_mobile_mount_v1__", baseFileSha256: sha(content.get(CONFIG)),
      insertedBlockSha256: sha(Buffer.from(BLOCK)), updatedFileSha256: sha(updatedConfig),
    } : null };
  const combined = { status: "matched-export-complete", sources: [source] };
  const inventoryBytes = Buffer.from(JSON.stringify(inventory, null, 2) + "\n");
  const combinedProvenanceBytes = Buffer.from(JSON.stringify(combined) + "\n");
  const sourceProvenance = { status: "complete", candidateManifestSha256: sha(inventoryBytes), candidateFiles: entries.length,
    candidateDigest: inventory.candidateDigest, sourceRoots: roots.map(({ sourceRoot, ...root }) => root), sourceTreeSha256,
    snapshotCopyMatchesSource: true, snapshotUnchangedDuringExport: true, sourceCompleteness: { builderInputFileCount: expectedFiles.length },
    sourceOrigin: { ...source, combinedProvenanceSha256: sha(combinedProvenanceBytes), builderSourceTreeSha256: sourceTreeSha256, oldRunContextInputRoots: roots } };
  const exportManifest = { status: "complete", inputRoots: roots, inputRootsAfter: structuredClone(roots), sourceUnchanged: true,
    sourceTreeSha256, sourceHashBefore: sourceTreeSha256, sourceHashAfter: sourceTreeSha256 };
  const objects = new Map([...content.values()].map(bytes => [blobId(bytes), bytes]));
  let idsRead;
  const args = { inventoryBytes, sourceProvenance, exportManifest, combinedProvenanceBytes,
    expectedCombinedProvenanceSha256: sha(combinedProvenanceBytes),
    readGitBlobs: async ids => { idsRead = [...ids]; return ids.map(id => objects.get(id)); } };
  return { args, inventory, combined, content, expectedFiles, get idsRead() { return idsRead; } };
}

for (const overlay of [false, true]) test(`derives exact Git bytes/root hashes with overlay=${overlay} and no live source directory`, async () => {
  const f = fixture({ overlay });
  const result = await derivePinnedGitExportSourceEvidence(f.args);
  assert.deepEqual(result.files, f.expectedFiles.sort((a, b) => {
    const left = `${a.root === "mobile" ? MOBILE : SHARED}/${a.path}`;
    const right = `${b.root === "mobile" ? MOBILE : SHARED}/${b.path}`;
    return left < right ? -1 : left > right ? 1 : 0;
  }));
  assert.equal(new Set(f.idsRead).size, f.idsRead.length);
  assert.equal(result.verificationMetadata.overlayApplied, overlay);
  assert.equal(result.verificationMetadata.gitFileCount, 5);
  assert.equal(result.verificationMetadata.exportFileCount, 4);
  assert.deepEqual(result.verificationMetadata.excludedPaths, [EXCLUDED]);
  assert.notEqual(result.verificationMetadata.inventoryRawSha256, result.verificationMetadata.candidateDigest);
  const evidence = { sourceRoots: result.sourceRoots, candidateSourceFiles: result.files,
    sourceMapSources: ["/src/runtime/sample.ts"], sourcesContent: [f.content.get(`${MOBILE}/src/runtime/sample.ts`).toString()] };
  assert.equal(resolvePinnedMetroSourcePath("/src/runtime/sample.ts", evidence).status, "PINNED_METRO_SOURCE");
  evidence.sourcesContent[0] = "self-authored map content";
  assert.equal(resolvePinnedMetroSourcePath("/src/runtime/sample.ts", evidence).status, "SOURCE_CONTENT_SHA256_MISMATCH");
});

test("raw inventory pin cannot be replaced with its logical digest", async () => {
  const { args } = fixture();
  args.sourceProvenance.candidateManifestSha256 = args.sourceProvenance.candidateDigest;
  await assert.rejects(derivePinnedGitExportSourceEvidence(args), /raw pin mismatch/);
});
test("logical inventory, commit, roots, and combined provenance must all match their pins", async () => {
  for (const change of [
    args => { args.sourceProvenance.candidateDigest = "0".repeat(64); },
    args => { args.sourceProvenance.sourceOrigin.commit = "0".repeat(40); },
    args => { args.exportManifest.inputRoots[0].sha256 = "0".repeat(64); },
    args => { args.expectedCombinedProvenanceSha256 = "0".repeat(64); },
    args => { args.combinedProvenanceBytes = Buffer.from("{}"); },
  ]) {
    const { args } = fixture(); change(args);
    await assert.rejects(derivePinnedGitExportSourceEvidence(args));
  }
});
test("a forged map-sourced blob, incomplete batch, non-buffer, and excessive blob are rejected", async () => {
  for (const readGitBlobs of [
    async ids => ids.map(() => Buffer.from("self-authored sourcesContent")),
    async () => [], async ids => ids.map(() => "not bytes"),
    async ids => Array(ids.length).fill(Buffer.alloc(16 * 1024 * 1024 + 1)),
  ]) await assert.rejects(derivePinnedGitExportSourceEvidence({ ...fixture().args, readGitBlobs }));
});
test("canonical paths, regular modes and duplicate paths are enforced", async () => {
  for (const mutate of [
    entry => { entry.path = MOBILE + "/../escaped.ts"; },
    entry => { entry.mode = "120000"; },
    (entry, entries) => { entry.path = entries[1].path; },
  ]) {
    const f = fixture(); mutate(f.inventory.entries[0], f.inventory.entries);
    f.args.inventoryBytes = Buffer.from(JSON.stringify(f.inventory));
    f.args.sourceProvenance.candidateManifestSha256 = sha(f.args.inventoryBytes);
    await assert.rejects(derivePinnedGitExportSourceEvidence(f.args));
  }
});
test("an additional exporter exclusion cannot silently shrink the accepted inventory", async () => {
  await assert.rejects(derivePinnedGitExportSourceEvidence(fixture({ extraExcluded: true }).args), /export exclusions differ/);
});
test("declared before overlay cannot be dropped, altered, or applied to a different base", async () => {
  for (const mutate of [
    source => { source.mountOverlay = null; },
    source => { source.mountOverlay.updatedFileSha256 = "0".repeat(64); },
    source => { source.mountOverlay.insertedBlockSha256 = "0".repeat(64); },
    source => { source.mountOverlay.baseFileSha256 = "0".repeat(64); },
  ]) {
    const f = fixture({ overlay: true }); mutate(f.combined.sources[0]);
    f.args.combinedProvenanceBytes = Buffer.from(JSON.stringify(f.combined));
    f.args.expectedCombinedProvenanceSha256 = sha(f.args.combinedProvenanceBytes);
    f.args.sourceProvenance.sourceOrigin.combinedProvenanceSha256 = f.args.expectedCombinedProvenanceSha256;
    await assert.rejects(derivePinnedGitExportSourceEvidence(f.args));
  }
});
