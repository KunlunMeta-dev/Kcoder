// One-off source-map-enabled Mobile Web export from the fixed current336 source snapshot.
// Reuses the existing owned RunContext and exportMobileWeb lifecycle; no Browser/Gateway.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { verifySourceMapBundleEvidence } from "../harness/render-profile-attribution-contract.mjs";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const TEST_ID = "mobile-web-export-current336-source-maps-20261009";
const SOURCE_FREEZE_ROOT = resolve(repoRoot, "target/private-phone-latency-implementation/current-mobile-sessions-default-lease-20261009-062104");
const SOURCE_ROOT = resolve(SOURCE_FREEZE_ROOT, "source");
const SOURCE_MAP = resolve(SOURCE_FREEZE_ROOT, "sha256.json");
const SOURCE_MANIFEST = resolve(SOURCE_FREEZE_ROOT, "source-manifest.json");
const SOURCE_METADATA = resolve(SOURCE_FREEZE_ROOT, "metadata.json");
const EXPECTED_SOURCE_SHA256 = "effa93130e74c958a4fd6639e79efab1d1a8bc78bcd18648aa9f70fe26f2b233";
const EXPECTED_SOURCE_MAP_SHA256 = "d78b6de305d13b7a9ce24798dc8cbd5a9c8afdeae7cc133111634259d97fb916";
const EXPECTED_SOURCE_MANIFEST_SHA256 = "604d8915c48d56ac58404990183072b73db0c63abd68821a974b311b2f4924a5";
const EXPECTED_SOURCE_FILES = 336;
const EXPECTED_ROOTS = [
  { name: "mobile", destination: "apps/kcoder-studio/mobile", fileCount: 317, sha256: "5dba68fbc5ba4a551ba71cf8cf5beb694392906635925527fed1a7ff8a113006" },
  { name: "studio-shared", destination: "apps/kcoder-studio/shared", fileCount: 19, sha256: "5443f5e695e75b82a1365baf90a3c280239bead8855647becfa2c9d67e91fe88" },
];
const DEPENDENCY_ROOT = resolve(repoRoot, "target/private-phone-ux-implementation/mobile-dependency-input-pinned");
const EXPECTED_DEPENDENCY_SOURCE_SHA256 = "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c";
const EXPECTED_DEPENDENCY_OWNED_SHA256 = "754d1db10bd502faeb0b6e82820d455cae680166008a443f7397457f1ef21d29";
const EXPECTED_DEPENDENCY_LOCK_SHA256 = "67c2d1c16857f0ed0f6d2ecb3dcf753f26a268b0f1675c1553018e37e9d231a3";
const BASELINE_ROOT = resolve(repoRoot, "target/private-phone-ux-implementation/mobile-web-export-sessions-default-lease-20261009-062104");
const BASELINE_MANIFEST_PATH = resolve(repoRoot, "target/private-phone-ux-implementation/mobile-web-export-sessions-default-lease-20261009-062104-manifest.json");
const EXPECTED_BASELINE_MANIFEST_SHA256 = "873acb13320c76f9f770418b909a1acc34aa069e4699a567bc2385756835d7d0";
const EXPECTED_BASELINE_BUNDLE_SHA256 = "73f068775c6d8a24f4051a1caeb05b4275f47af2cb35390704fb28aa58816689";
const OUTPUT_PACKAGE_ROOT = resolve(repoRoot, "target/private-phone-ux-implementation/mobile-web-export-current336-source-maps-20261009");
const OUTPUT_BUNDLE_ROOT = resolve(OUTPUT_PACKAGE_ROOT, "bundle");
const OUTPUT_MANIFEST_PATH = resolve(OUTPUT_PACKAGE_ROOT, "export-manifest.json");
const OUTPUT_PROVENANCE_PATH = resolve(OUTPUT_PACKAGE_ROOT, "provenance.json");
const NODE_PATH = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const NODE_SHA256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function safeRelative(value, label) {
  assert.equal(typeof value, "string", label + " must be a string");
  assert.ok(value.length > 0 && !value.startsWith("/") && !value.includes("\\"), label + " must be a normalized relative path");
  const parts = value.split("/");
  assert.ok(parts.every((part) => part && part !== "." && part !== ".."), label + " contains a traversal segment");
  return parts;
}

function pathWithin(root, candidate, label) {
  const normalizedRoot = resolve(root);
  const normalized = resolve(candidate);
  assert.ok(normalized.startsWith(normalizedRoot + sep), label + " escaped its pinned root");
  return normalized;
}

async function assertRealDirectory(path, label) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), label + " must be a real directory");
  assert.equal(await realpath(path), resolve(path), label + " must be canonical");
  return info;
}

async function assertAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  assert.fail(label + " already exists; refusing to replace it");
}

async function hashTree(root) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const info = await lstat(absolute);
      assert.ok(!info.isSymbolicLink(), "frozen source contains a symlink: " + absolute);
      if (info.isDirectory()) {
        await visit(absolute);
      } else {
        assert.ok(info.isFile(), "frozen source contains a special file: " + absolute);
        const bytes = await readFile(absolute);
        entries.push({ path: relative(root, absolute).split(sep).join("/"), size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(root);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

async function verifyFrozenSource() {
  await assertRealDirectory(SOURCE_FREEZE_ROOT, "current336 source freeze");
  await assertRealDirectory(SOURCE_ROOT, "current336 source tree");
  const [mapBytes, manifestBytes, metadataBytes] = await Promise.all([
    readFile(SOURCE_MAP), readFile(SOURCE_MANIFEST), readFile(SOURCE_METADATA),
  ]);
  assert.equal(sha256(mapBytes), EXPECTED_SOURCE_MAP_SHA256, "current336 source SHA map changed");
  assert.equal(sha256(manifestBytes), EXPECTED_SOURCE_MANIFEST_SHA256, "current336 source manifest bytes changed");
  const map = JSON.parse(mapBytes.toString("utf8"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  assert.equal(metadata.status, "CURRENT_SOURCE_FROZEN_FOR_STATIC_EXPORT");
  assert.equal(metadata.sourceDigest, EXPECTED_SOURCE_SHA256);
  assert.equal(metadata.sourceFiles, EXPECTED_SOURCE_FILES);
  assert.equal(metadata.sha256MapSha256, EXPECTED_SOURCE_MAP_SHA256);
  assert.equal(metadata.sourceManifestSha256, EXPECTED_SOURCE_MANIFEST_SHA256);
  assert.equal(metadata.sourceUnchangedDuringFreeze, true);
  assert.equal(metadata.copiedSnapshotMatchesLiveSource, true);
  assert.equal(manifest.status, "FROZEN_CURRENT_SOURCE_FOR_STATIC_WEB_EXPORT");
  assert.equal(manifest.sourceDigest, EXPECTED_SOURCE_SHA256);
  assert.equal(manifest.fileCount, EXPECTED_SOURCE_FILES);
  assert.equal(manifest.noCredentialStateCopied, true);
  assert.deepEqual(manifest.roots.map(({ name, destination, fileCount, sha256: digest }) => ({ name, destination, fileCount, sha256: digest })), EXPECTED_ROOTS);
  assert.deepEqual(metadata.sourceRoots.map(({ name, destination, fileCount, sha256: digest }) => ({ name, destination, fileCount, sha256: digest })), EXPECTED_ROOTS);
  assert.equal(manifest.files.length, EXPECTED_SOURCE_FILES);
  assert.equal(Object.keys(map).length, EXPECTED_SOURCE_FILES);
  assert.deepEqual(Object.keys(map).sort(), manifest.files.map(({ path }) => path).sort(), "source SHA map and freeze manifest path sets differ");

  const actualAll = [];
  const rootEvidence = [];
  for (const root of EXPECTED_ROOTS) {
    const sourceRoot = pathWithin(SOURCE_ROOT, resolve(SOURCE_ROOT, root.destination), root.name + " source root");
    await assertRealDirectory(sourceRoot, root.name + " frozen root");
    const actualRelative = await hashTree(sourceRoot);
    const actualFull = actualRelative.map((entry) => ({ path: root.destination + "/" + entry.path, size: entry.size, sha256: entry.sha256 }));
    const manifestFull = manifest.files.filter((entry) => entry.path.startsWith(root.destination + "/"));
    assert.deepEqual(actualFull, manifestFull, root.name + " actual frozen files differ from the raw manifest");
    assert.equal(actualFull.length, root.fileCount, root.name + " frozen file count changed");
    for (const entry of actualFull) assert.equal(map[entry.path], entry.sha256, "frozen source digest mismatch: " + entry.path);
    assert.equal(hashJson(actualRelative), root.sha256, root.name + " root digest differs from the pinned current336 record");
    actualAll.push(...actualFull);
    rootEvidence.push({ name: root.name, destination: root.destination, fileCount: actualFull.length, sha256: root.sha256 });
  }
  actualAll.sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(actualAll, manifest.files, "current336 complete source tree differs from its raw freeze inventory");
  assert.equal(hashJson(rootEvidence.map(({ name, destination, sha256: digest }) => ({ name, destination, sha256: digest }))), EXPECTED_SOURCE_SHA256);

  const dependencyInfo = await assertRealDirectory(DEPENDENCY_ROOT, "pinned dependency snapshot");
  assert.equal(dependencyInfo.mode & 0o777, 0o700, "pinned dependency snapshot mode changed");
  const lockPath = resolve(DEPENDENCY_ROOT, ".package-lock.json");
  const lockInfo = await lstat(lockPath);
  assert.ok(lockInfo.isFile() && !lockInfo.isSymbolicLink(), "pinned dependency lock must be a regular file");
  assert.equal(sha256(await readFile(lockPath)), EXPECTED_DEPENDENCY_LOCK_SHA256, "pinned dependency lock changed");
  return {
    sourceDigest: EXPECTED_SOURCE_SHA256,
    sourceManifestSha256: EXPECTED_SOURCE_MANIFEST_SHA256,
    sourceMapSha256: EXPECTED_SOURCE_MAP_SHA256,
    sourceFileCount: EXPECTED_SOURCE_FILES,
    roots: rootEvidence,
    sourceCommit: metadata.sourceCommit,
    sourceWorktreeDirty: metadata.sourceWorktreeDirty,
    dependencyRoot: DEPENDENCY_ROOT,
    dependencyLockSha256: EXPECTED_DEPENDENCY_LOCK_SHA256,
  };
}

async function verifyNormalBaseline() {
  const manifestBytes = await readFile(BASELINE_MANIFEST_PATH);
  assert.equal(sha256(manifestBytes), EXPECTED_BASELINE_MANIFEST_SHA256, "current336 normal-export manifest bytes changed");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.sourceTreeSha256, EXPECTED_SOURCE_SHA256);
  assert.equal(manifest.bundleSha256, EXPECTED_BASELINE_BUNDLE_SHA256);
  assert.equal(manifest.bundleFileCount, 37);
  assert.equal(manifest.bundleFiles.length, 37);
  assert.equal(manifest.dependencyProvenance.sourceTreeSha256Before, EXPECTED_DEPENDENCY_SOURCE_SHA256);
  assert.equal(manifest.dependencyProvenance.sourceTreeSha256After, EXPECTED_DEPENDENCY_SOURCE_SHA256);
  assert.equal(manifest.dependencyProvenance.copiedTreeSha256, EXPECTED_DEPENDENCY_OWNED_SHA256);
  assert.equal(hashJson(manifest.bundleFiles), EXPECTED_BASELINE_BUNDLE_SHA256);
  await assertRealDirectory(BASELINE_ROOT, "current336 ordinary 37-file baseline bundle");
  for (const entry of manifest.bundleFiles) {
    const parts = safeRelative(entry.path, "baseline bundle path");
    let cursor = BASELINE_ROOT;
    for (const part of parts) {
      cursor = resolve(cursor, part);
      const info = await lstat(cursor);
      assert.ok(!info.isSymbolicLink(), "baseline bundle path contains a symlink: " + entry.path);
    }
    const info = await lstat(cursor);
    assert.ok(info.isFile(), "baseline bundle asset is not regular: " + entry.path);
    const bytes = await readFile(cursor);
    assert.equal(bytes.length, entry.size, "baseline asset size mismatch: " + entry.path);
    assert.equal(sha256(bytes), entry.sha256, "baseline asset digest mismatch: " + entry.path);
  }
  return { manifestBytes, manifest, sha256: sha256(manifestBytes), bundleRoot: BASELINE_ROOT };
}

async function copyBundle(sourceRoot, stageBundleRoot, entries, expectedBundleSha256) {
  await mkdir(stageBundleRoot, { recursive: false, mode: 0o700 });
  const copied = [];
  for (const entry of entries) {
    const parts = safeRelative(entry.path, "source-map bundle path");
    let source = sourceRoot;
    let destination = stageBundleRoot;
    for (const part of parts) {
      source = resolve(source, part);
      destination = resolve(destination, part);
    }
    assert.ok(source.startsWith(sourceRoot + sep), "bundle source escaped: " + entry.path);
    assert.ok(destination.startsWith(stageBundleRoot + sep), "bundle destination escaped: " + entry.path);
    const sourceInfo = await lstat(source);
    assert.ok(sourceInfo.isFile() && !sourceInfo.isSymbolicLink(), "export bundle entry must be regular: " + entry.path);
    const bytes = await readFile(source);
    assert.equal(bytes.length, entry.size, "export bundle size changed: " + entry.path);
    assert.equal(sha256(bytes), entry.sha256, "export bundle hash changed: " + entry.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    await chmod(destination, 0o444);
    copied.push({ path: entry.path, size: bytes.length, sha256: sha256(await readFile(destination)) });
  }
  copied.sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(hashJson(copied), expectedBundleSha256, "portable source-map bundle differs from the RunContext manifest");
  return copied;
}

async function makeTreeReadOnly(root) {
  const children = await readdir(root, { withFileTypes: true });
  for (const child of children) {
    const childPath = resolve(root, child.name);
    const info = await lstat(childPath);
    assert.ok(!info.isSymbolicLink(), "portable source-map package cannot contain symlinks");
    if (info.isDirectory()) await makeTreeReadOnly(childPath);
    else assert.ok(info.isFile(), "portable source-map package cannot contain special files");
  }
  await chmod(root, 0o500);
}

async function writeStageJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await chmod(path, 0o444);
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 1 && ["--preflight", "--execute"].includes(args[0]),
    "usage: mobile-web-export-current336-source-maps.once.mjs --preflight|--execute",
  );
  assert.equal(process.execPath, NODE_PATH, "run with the pinned Node 22.17 executable");
  assert.equal(process.version, "v22.17.0");
  assert.equal(sha256(await readFile(process.execPath)), NODE_SHA256, "pinned Node binary changed");
  const freeze = await verifyFrozenSource();
  const baseline = await verifyNormalBaseline();
  const outputParent = dirname(OUTPUT_PACKAGE_ROOT);
  await assertRealDirectory(outputParent, "approved private package parent");
  await assertAbsent(OUTPUT_PACKAGE_ROOT, "portable source-map output package");
  await assertAbsent(OUTPUT_MANIFEST_PATH, "source-map export manifest");
  await assertAbsent(OUTPUT_PROVENANCE_PATH, "source-map provenance");
  if (args[0] === "--preflight") {
    console.log(JSON.stringify({
      status: "preflight-ready",
      sourceMaps: true,
      node: { path: NODE_PATH, version: process.version, sha256: NODE_SHA256 },
      frozenSource: freeze,
      normalBaseline: { manifestPath: BASELINE_MANIFEST_PATH, manifestSha256: baseline.sha256, bundleSha256: EXPECTED_BASELINE_BUNDLE_SHA256, fileCount: 37 },
      dependency: { root: DEPENDENCY_ROOT, sourceTreeSha256: EXPECTED_DEPENDENCY_SOURCE_SHA256, ownedTreeSha256: EXPECTED_DEPENDENCY_OWNED_SHA256, lockSha256: EXPECTED_DEPENDENCY_LOCK_SHA256 },
      output: { packageRoot: OUTPUT_PACKAGE_ROOT, bundleRoot: OUTPUT_BUNDLE_ROOT, manifestPath: OUTPUT_MANIFEST_PATH, provenancePath: OUTPUT_PROVENANCE_PATH },
      browser: false,
      gateway: false,
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({
    status: "starting-owned-source-map-export",
    execute: true,
    node: { path: NODE_PATH, version: process.version, sha256: NODE_SHA256 },
    frozenSource: freeze,
    normalBaseline: { manifestPath: BASELINE_MANIFEST_PATH, manifestSha256: baseline.sha256, bundleSha256: EXPECTED_BASELINE_BUNDLE_SHA256, fileCount: 37 },
    dependency: { sourceTreeSha256: EXPECTED_DEPENDENCY_SOURCE_SHA256, ownedTreeSha256: EXPECTED_DEPENDENCY_OWNED_SHA256, lockSha256: EXPECTED_DEPENDENCY_LOCK_SHA256 },
    sourceMaps: true,
    browser: false,
    gateway: false,
    output: { packageRoot: OUTPUT_PACKAGE_ROOT, bundleRoot: OUTPUT_BUNDLE_ROOT, manifestPath: OUTPUT_MANIFEST_PATH, provenancePath: OUTPUT_PROVENANCE_PATH },
  }, null, 2));

  const result = await runE2E(import.meta.url, {
    testId: TEST_ID,
    tier: "manual-live",
    modelPolicy: "source-map-enabled Mobile Web export from immutable current336 source and pinned dependency snapshots; attribution artifact only, no Browser, Gateway, Provider, model, public endpoint, native runtime, or user credentials",
    retainSuccessLogs: true,
    cleanupTimeoutMs: 20_000,
    survivorCheckTimeoutMs: 5_000,
    sourceDigest: freeze.sourceDigest,
    sourceManifestSha256: freeze.sourceManifestSha256,
    sourceFileCount: freeze.sourceFileCount,
    dependencySourceTreeSha256: EXPECTED_DEPENDENCY_SOURCE_SHA256,
    sourceMaps: true,
  }, async (context) => {
    await context.writeArtifactJson("current336-source-freeze-proof.json", {
      sourceFreezeRoot: SOURCE_FREEZE_ROOT,
      sourceManifestPath: SOURCE_MANIFEST,
      sourceManifestSha256: freeze.sourceManifestSha256,
      sourceMapPath: SOURCE_MAP,
      sourceMapSha256: freeze.sourceMapSha256,
      sourceDigest: freeze.sourceDigest,
      sourceFileCount: freeze.sourceFileCount,
      roots: freeze.roots,
      sourceCommit: freeze.sourceCommit,
      sourceWorktreeDirty: freeze.sourceWorktreeDirty,
      credentialStateCopied: false,
    });

    const mobileRoot = resolve(SOURCE_ROOT, "apps/kcoder-studio/mobile");
    const sharedRoot = resolve(SOURCE_ROOT, "apps/kcoder-studio/shared");
    const exported = await exportMobileWeb(context, {
      mobileRoot,
      sourceRoots: [
        { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
        { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
      ],
      dependencyRoot: DEPENDENCY_ROOT,
      label: "current336-source-maps-20261009",
      outputName: "mobile-web-current336-source-maps-20261009",
      timeoutMs: 180_000,
      sourceMaps: true,
    });
    assert.equal(exported.sourceTreeSha256, EXPECTED_SOURCE_SHA256, "exporter did not build the exact current336 frozen tree");
    assert.equal(exported.dependencySourceTreeSha256, EXPECTED_DEPENDENCY_SOURCE_SHA256, "exporter used a different dependency input tree");
    assert.equal(exported.dependencyOwnedTreeSha256, EXPECTED_DEPENDENCY_OWNED_SHA256, "owned dependency copy differs from its pinned digest");
    assert.equal(exported.bundleFileCount, exported.bundleFiles.length);
    assert.ok(exported.bundleFiles.length > 37, "sourceMaps=true must add map files to the standard bundle");
    const exportManifestBytes = await readFile(exported.bundleManifestPath);
    const exportManifest = JSON.parse(exportManifestBytes.toString("utf8"));
    assert.equal(exportManifest.status, "complete", exportManifest.error || "source-map-enabled export must complete");
    assert.equal(exportManifest.sourceUnchanged, true);
    assert.equal(exportManifest.snapshotCopyMatchesSource, true);
    assert.equal(exportManifest.snapshotUnchangedDuringExport, true);
    assert.equal(exportManifest.dependencyProvenance.sourceUnchanged, true);
    assert.equal(exportManifest.terminalHookChangesOnlyGeneratedHtml, true);
    verifySourceMapBundleEvidence(exportManifest.sourceMapEvidence, exportManifest);

    const mapEntries = exported.bundleFiles.filter((entry) => entry.path.endsWith(".map"));
    const regularEntries = exported.bundleFiles.filter((entry) => !entry.path.endsWith(".map"));
    assert.equal(regularEntries.length, 37, "source-map mode must keep exactly the normal 37 bundle files in addition to maps");
    assert.deepEqual(regularEntries.map(({ path }) => path).sort(), baseline.manifest.bundleFiles.map(({ path }) => path).sort(), "source-map mode changed the standard asset path set");
    const baselineByPath = new Map(baseline.manifest.bundleFiles.map((entry) => [entry.path, entry]));
    const javaScriptDiff = regularEntries.filter(({ path }) => path.endsWith(".js")).map((entry) => ({
      path: entry.path,
      beforeSha256: baselineByPath.get(entry.path) ? baselineByPath.get(entry.path).sha256 : null,
      afterSha256: entry.sha256,
      unchanged: Boolean(baselineByPath.get(entry.path) && baselineByPath.get(entry.path).sha256 === entry.sha256),
    }));
    assert.ok(javaScriptDiff.length > 0, "normal bundle must contain at least one JavaScript output for comparison");
    const changedJavaScriptCount = javaScriptDiff.filter((entry) => !entry.unchanged).length;

    const stageRoot = context.pathInState("portable-source-map-package");
    await assertAbsent(stageRoot, "RunContext-owned portable source-map staging package");
    await mkdir(stageRoot, { recursive: false, mode: 0o700 });
    const stagedBundle = resolve(stageRoot, "bundle");
    const copiedEntries = await copyBundle(exported.path, stagedBundle, exported.bundleFiles, exported.bundleSha256);
    const stagedManifest = resolve(stageRoot, "export-manifest.json");
    await writeFile(stagedManifest, exportManifestBytes, { flag: "wx", mode: 0o600 });
    await chmod(stagedManifest, 0o444);
    const provenance = {
      schemaVersion: 1,
      status: "complete",
      purpose: "private source-map-enabled Mobile Web export for mapped render-profile attribution; not a performance sample and not a public deployment",
      frozenSourceManifestSha256: freeze.sourceManifestSha256,
      frozenSourceManifestPath: SOURCE_MANIFEST,
      frozenSourceEntryCount: freeze.sourceFileCount,
      sourceTreeSha256: freeze.sourceDigest,
      sourceCommit: freeze.sourceCommit,
      sourceWorktreeDirty: freeze.sourceWorktreeDirty,
      sourceCompleteness: { manifestFileCount: freeze.sourceFileCount, workspaceComplementCopied: false },
      sourceComplementSha256: null,
      sourceComplementStableDuringCopy: null,
      complementarySourceDescription: "Mobile and studio-shared roots are fully covered by the exact current336 frozen-source manifest",
      sourceRoots: freeze.roots,
      dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
      dependencyLockSha256: EXPECTED_DEPENDENCY_LOCK_SHA256,
      bundleManifest: OUTPUT_MANIFEST_PATH,
      bundlePath: OUTPUT_BUNDLE_ROOT,
      bundleSha256: exported.bundleSha256,
      sourceMapEvidence: exportManifest.sourceMapEvidence,
      exporterManifestSha256: sha256(exportManifestBytes),
      exporterSourceUnchanged: exportManifest.sourceUnchanged,
      snapshotCopyMatchesSource: exportManifest.snapshotCopyMatchesSource,
      snapshotUnchangedDuringExport: exportManifest.snapshotUnchangedDuringExport,
      terminalHookChangesOnlyGeneratedHtml: exportManifest.terminalHookChangesOnlyGeneratedHtml,
      credentialStateCopied: false,
      standardBundleBaseline: {
        manifestPath: BASELINE_MANIFEST_PATH,
        manifestSha256: baseline.sha256,
        bundleSha256: EXPECTED_BASELINE_BUNDLE_SHA256,
        sourceTreeSha256: EXPECTED_SOURCE_SHA256,
        bundleFileCount: 37,
        javaScriptDiff,
        changedJavaScriptCount,
      },
      bundle: {
        root: OUTPUT_BUNDLE_ROOT,
        bundleSha256: exported.bundleSha256,
        bundleFileCount: exported.bundleFileCount,
        regularFileCount: regularEntries.length,
        mapFileCount: mapEntries.length,
        mapFiles: mapEntries,
        copiedBundleSha256: hashJson(copiedEntries),
        indexHtmlSha256: exported.indexHtmlSha256,
      },
      attributionBoundary: "Source maps are pinned to this complete bundle digest. Profile script URLs must resolve to the exact served bundle path; unmatched or foreign URLs remain unresolved. Mapped file paths are scoped/redacted by the E2E attribution contract. Source map contents are kept only in the approved private package and are not printed.",
    };
    await context.writeArtifactJson("current336-source-map-export-provenance.json", provenance);
    await writeStageJson(resolve(stageRoot, "provenance.json"), provenance);
    await makeTreeReadOnly(stageRoot);
    await assertAbsent(OUTPUT_PACKAGE_ROOT, "portable source-map output package");
    await rename(stageRoot, OUTPUT_PACKAGE_ROOT);
    assert.equal(sha256(await readFile(resolve(OUTPUT_PACKAGE_ROOT, "export-manifest.json"))), sha256(exportManifestBytes), "portable export manifest copy changed");
    const finalProvenance = JSON.parse(await readFile(resolve(OUTPUT_PACKAGE_ROOT, "provenance.json"), "utf8"));
    assert.equal(finalProvenance.bundleSha256, exported.bundleSha256);
    return {
      status: "source-map-export-complete",
      sourceDigest: exported.sourceTreeSha256,
      sourceFileCount: EXPECTED_SOURCE_FILES,
      sourceManifestSha256: freeze.sourceManifestSha256,
      dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
      normalBundleSha256: EXPECTED_BASELINE_BUNDLE_SHA256,
      bundleSha256: exported.bundleSha256,
      bundleFileCount: exported.bundleFileCount,
      mapFileCount: mapEntries.length,
      changedJavaScriptCount,
      packageRoot: OUTPUT_PACKAGE_ROOT,
      bundleRoot: OUTPUT_BUNDLE_ROOT,
      manifestPath: OUTPUT_MANIFEST_PATH,
      provenancePath: OUTPUT_PROVENANCE_PATH,
      exporterPids: {
        dependencyCopier: exported.dependencyCopierPid,
        terminalBuilder: exported.terminalBuilderPid,
        expo: exported.exporterPid,
      },
    };
  });
  console.log(JSON.stringify(result, null, 2));
}

await main();
