import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { copyFrozenMobileWeb } from "../harness/frozen-copy.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const TEST_ID = "mobile-combined-web-export-f2b0df88-20261009";
const MOBILE_ROOT = resolve(repoRoot, "apps/kcoder-studio/mobile");
const SHARED_ROOT = resolve(repoRoot, "apps/kcoder-studio/shared");
const DEPENDENCY_ROOT = resolve(MOBILE_ROOT, "node_modules");
const PERSISTENT_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/private-phone-ux-implementation/mobile-combined-validation-f2b0df88-20261009-01/expo-web-export";

async function assertAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.fail(`${label} already exists; refusing to replace it`);
}

async function writeExclusiveJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

await runE2E(import.meta.url, {
  testId: TEST_ID,
  kind: "model-independent",
  modelPolicy: "none",
  summary: "Combined Mobile Web Expo export with persistent verified bundle copy",
}, async context => {
  assert.equal(process.execPath, "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node");
  assert.equal(process.version, "v22.17.0");
  await Promise.all([access(MOBILE_ROOT), access(SHARED_ROOT), access(DEPENDENCY_ROOT)]);
  await assertAbsent(PERSISTENT_ROOT, "persistent Mobile Web export root");
  await mkdir(PERSISTENT_ROOT, { recursive: false, mode: 0o700 });

  const exported = await exportMobileWeb(context, {
    mobileRoot: MOBILE_ROOT,
    sourceRoots: [
      { name: "mobile", path: MOBILE_ROOT, destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: SHARED_ROOT, destination: "apps/kcoder-studio/shared" },
    ],
    dependencyRoot: DEPENDENCY_ROOT,
    label: "combined-mobile",
    outputName: "combined-mobile-web-export",
    timeoutMs: 600_000,
  });

  const manifest = JSON.parse(await readFile(exported.bundleManifestPath, "utf8"));
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.sourceUnchanged, true);
  assert.equal(manifest.snapshotCopyMatchesSource, true);
  assert.equal(manifest.snapshotUnchangedDuringExport, true);
  assert.equal(manifest.dependencyProvenance?.sourceUnchanged, true);

  const persistentBundle = resolve(PERSISTENT_ROOT, "bundle");
  const persisted = await copyFrozenMobileWeb({
    sourceRoot: exported.path,
    destination: persistentBundle,
    expectedBundleSha256: exported.bundleSha256,
    manifestPath: exported.bundleManifestPath,
    expectedSourceTreeSha256: exported.sourceTreeSha256,
    expectedDependencySourceTreeSha256: exported.dependencySourceTreeSha256,
    expectedDependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
  });
  const persistentManifest = resolve(PERSISTENT_ROOT, "bundle-manifest.json");
  await copyFile(exported.bundleManifestPath, persistentManifest);
  const nodeSha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
  const provenance = {
    schemaVersion: 1,
    status: "verified-copy",
    testId: TEST_ID,
    runRoot: context.runRoot,
    gitHead: context.gitCommit,
    node: { path: process.execPath, version: process.version, sha256: nodeSha256 },
    sourceTreeSha256: exported.sourceTreeSha256,
    sourceRoots: exported.sourceRoots,
    dependencyRoot: exported.dependencyRoot,
    dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
    dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
    bundleSha256: exported.bundleSha256,
    bundleFileCount: exported.bundleFileCount,
    indexHtmlSha256: exported.indexHtmlSha256,
    persistentBundle,
    persistentManifest,
    verifiedCopy: persisted,
  };
  await writeExclusiveJson(resolve(PERSISTENT_ROOT, "provenance.json"), provenance);
  await context.writeArtifactJson("combined-mobile-web-export-persisted.json", provenance);
  return provenance;
});
