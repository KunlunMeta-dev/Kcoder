// Exact current339 default/catalog export entry; prepared only, execution requires explicit authorization.
// Explicit --freeze never invokes exportMobileWeb; --execute awaits Root authorization. No Browser, Gateway, Provider, or user session.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const execFileAsync = promisify(execFile);
const TEST_ID = "mobile-web-export-default-catalog-parallel-20261009-090018";
const EXPECTED_HEAD = "0f2e391986e14144f5c4e5643fcac2e5d7f1306d";
const BASE_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/phone-ux-upstream-integration-20261008/target/private-phone-latency-implementation/current-mobile-sessions-default-lease-20261009-062104";
const BASE_SOURCE_DIGEST = "effa93130e74c958a4fd6639e79efab1d1a8bc78bcd18648aa9f70fe26f2b233";
const BASE_MANIFEST_SHA256 = "d78b6de305d13b7a9ce24798dc8cbd5a9c8afdeae7cc133111634259d97fb916";
const BASE_FILE_COUNT = 336;
const CANDIDATE_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/phone-ux-upstream-integration-20261008/target/private-phone-latency-implementation/current-mobile-default-catalog-parallel-20261009-090018";
const CANDIDATE_SOURCE_ROOT = resolve(CANDIDATE_ROOT, "source");
const CANDIDATE_SOURCE_DIGEST = "649a35cd63b42a43bb2cba9e74fdc2ba9e1586090f56507a0f4dd3cc4ad6667f";
const CANDIDATE_FILE_COUNT = 339;
const CANDIDATE_ROOTS = [{"name": "mobile", "destination": "apps/kcoder-studio/mobile", "path": "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/phone-ux-upstream-integration-20261008/apps/kcoder-studio/mobile", "fileCount": 320, "sha256": "d447f96d87465fff1c9cb90044ad6a52e4faf36746bd3c86daf568b9fbba58e8"}, {"name": "studio-shared", "destination": "apps/kcoder-studio/shared", "path": "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/phone-ux-upstream-integration-20261008/apps/kcoder-studio/shared", "fileCount": 19, "sha256": "5443f5e695e75b82a1365baf90a3c280239bead8855647becfa2c9d67e91fe88"}];
const EXPECTED_ADDED = ["apps/kcoder-studio/mobile/src/app/__tests__/default-catalog-parallel-routes.review.test.tsx", "apps/kcoder-studio/mobile/src/runtime/task-runtime/default-catalog-parallel.review.test.ts", "apps/kcoder-studio/mobile/src/state/AppContext.routine-workspace-cache.review.test.tsx"];
const EXPECTED_CHANGED = ["apps/kcoder-studio/mobile/src/app/h/[profileId]/index.tsx", "apps/kcoder-studio/mobile/src/app/sessions.tsx", "apps/kcoder-studio/mobile/src/runtime/task-runtime/workspaces.ts", "apps/kcoder-studio/mobile/src/state/AppContext.tsx"];
const EXPECTED_REMOVED = [];
const DEPENDENCY_ROOT = resolve(repoRoot, "target/private-phone-ux-implementation/mobile-dependency-input-pinned");
const DEPENDENCY_SOURCE_SHA256 = "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c";
const DEPENDENCY_OWNED_SHA256 = "754d1db10bd502faeb0b6e82820d455cae680166008a443f7397457f1ef21d29";
const DEPENDENCY_LOCK_SHA256 = "67c2d1c16857f0ed0f6d2ecb3dcf753f26a268b0f1675c1553018e37e9d231a3";
const NODE = {
  path: "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node",
  version: "v22.17.0",
  sha256: "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9",
};
const HELPER_PINS = new Map([
  ["apps/kcoder-studio/e2e/harness/frozen-copy.mjs", "4b7207ca2718bba5cef8923004f6080a9c2d1110166b5909f9dbddf3b8e8ac6e"],
  ["apps/kcoder-studio/e2e/harness/mobile-web-export.mjs", "a40e87a8a117e09027dbc000622057204d9441a7506ba7f54524364131f63a2e"],
  ["apps/kcoder-studio/e2e/harness/run-context.mjs", "94f0c27306f8944cbd10f1835227a408c51a0b558981d846832bb297c5e5cf11"],
  ["apps/kcoder-studio/e2e/harness/retention.mjs", "9df5193dc1f4bd5565731cf92d0154bb8f3993e8d3c7c3d98f530c8738716532"],
  ["apps/kcoder-studio/e2e/harness/owned-process.mjs", "40a230721ead1ff78877c1b2815aafd220279bccd43d15d78303f30a59cb78af"],
]);
const OUTPUT_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/phone-ux-upstream-integration-20261008/target/private-phone-ux-implementation/mobile-web-export-default-catalog-parallel-20261009-090018";
const OUTPUT_MANIFEST = `${OUTPUT_ROOT}-manifest.json`;
const OUTPUT_PROVENANCE = `${OUTPUT_ROOT}-provenance.json`;
const SOURCE_OMIT_DIRS = new Set([".expo", ".git", "dist", "node_modules"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function isSourceEntryOmitted(name) {
  if (SOURCE_OMIT_DIRS.has(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  return /(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name);
}

function safeRelativePath(value) {
  assert.equal(typeof value, "string");
  assert.ok(value && !value.startsWith("/") && !value.split(/[\\/]/).includes(".."), `unsafe relative path: ${value}`);
  return value;
}

async function assertRealDirectory(path, label, mode) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a real directory`);
  assert.equal(await realpath(path), resolve(path), `${label} must be canonical`);
  if (mode !== undefined) assert.equal(info.mode & 0o777, mode, `${label} mode changed`);
  if (typeof process.getuid === "function") assert.equal(info.uid, process.getuid(), `${label} owner changed`);
  return info;
}

async function assertAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.fail(`${label} already exists; refusing to replace it`);
}

async function collectRoot(rootPath, destination) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (isSourceEntryOmitted(child.name)) continue;
      const path = resolve(directory, child.name);
      const info = await lstat(path);
      const localPath = relative(rootPath, path).split(sep).join("/");
      assert.ok(!info.isSymbolicLink(), `source contains a symlink: ${destination}/${localPath}`);
      if (info.isDirectory()) {
        await visit(path);
      } else if (info.isFile()) {
        const bytes = await readFile(path);
        entries.push({ path: localPath, size: bytes.length, sha256: sha256(bytes) });
      } else {
        assert.fail(`source contains a special file: ${destination}/${localPath}`);
      }
    }
  }
  await visit(rootPath);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    name: destination === "apps/kcoder-studio/mobile" ? "mobile" : "studio-shared",
    destination,
    sourceRoot: rootPath,
    entries,
    fileCount: entries.length,
    sha256: hashJson(entries),
  };
}

async function collectCurrent() {
  const roots = [];
  for (const root of CANDIDATE_ROOTS) roots.push(await collectRoot(root.path, root.destination));
  const digest = hashJson(roots.map(({ name, destination, sha256: rootSha }) => ({ name, destination, sha256: rootSha })));
  const files = roots.flatMap(root => root.entries.map(entry => ({
    path: `${root.destination}/${entry.path}`,
    size: entry.size,
    sha256: entry.sha256,
  })));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { roots, files, digest, fileCount: files.length };
}

async function verifyBase() {
  await assertRealDirectory(BASE_ROOT, "pinned B source freeze");
  const baseMapPath = resolve(BASE_ROOT, "sha256.json");
  const baseMapInfo = await lstat(baseMapPath);
  assert.ok(baseMapInfo.isFile() && !baseMapInfo.isSymbolicLink(), "pinned B hash map must be a regular file");
  const baseMapBytes = await readFile(baseMapPath);
  assert.equal(sha256(baseMapBytes), BASE_MANIFEST_SHA256, "B source manifest bytes changed");
  const baseMap = JSON.parse(baseMapBytes.toString("utf8"));
  assert.equal(Object.keys(baseMap).length, BASE_FILE_COUNT);

  const metadataPath = resolve(BASE_ROOT, "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  assert.equal(metadata.sourceDigest, BASE_SOURCE_DIGEST);
  assert.equal(metadata.sourceFiles, BASE_FILE_COUNT);
  assert.deepEqual(metadata.sourceRoots.map(root => ({
    name: root.name,
    destination: root.destination,
    fileCount: root.fileCount,
    sha256: root.sha256,
  })), [
    {"name": "mobile", "destination": "apps/kcoder-studio/mobile", "fileCount": 317, "sha256": "5dba68fbc5ba4a551ba71cf8cf5beb694392906635925527fed1a7ff8a113006"},
    {"name": "studio-shared", "destination": "apps/kcoder-studio/shared", "fileCount": 19, "sha256": "5443f5e695e75b82a1365baf90a3c280239bead8855647becfa2c9d67e91fe88"},
  ]);

  for (const [relativePath, expectedHash] of Object.entries(baseMap)) {
    safeRelativePath(relativePath);
    const path = resolve(BASE_ROOT, "source", relativePath);
    assert.ok(path.startsWith(`${BASE_ROOT}${sep}`), "B source path escaped its freeze root");
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `B source must be regular: ${relativePath}`);
    assert.equal(sha256(await readFile(path)), expectedHash, `B source hash changed: ${relativePath}`);
  }
  return { baseMap, metadata };
}

function compareCandidate(candidate, baseMap) {
  const currentMap = Object.fromEntries(candidate.files.map(file => [file.path, file.sha256]));
  const added = Object.keys(currentMap).filter(path => !(path in baseMap)).sort();
  const changed = Object.keys(currentMap).filter(path => path in baseMap && currentMap[path] !== baseMap[path]).sort();
  const removed = Object.keys(baseMap).filter(path => !(path in currentMap)).sort();
  assert.deepEqual(added, EXPECTED_ADDED, "current source additions differ from reviewed P1/reconnect delta");
  assert.deepEqual(changed, EXPECTED_CHANGED, "current source changes differ from reviewed P1/reconnect delta");
  assert.deepEqual(removed, EXPECTED_REMOVED, "current source removals differ from B");
  return { added, changed, removed };
}

async function verifyRuntimeInputs() {
  assert.equal(process.execPath, NODE.path, "must run with the pinned Node executable");
  assert.equal(process.version, NODE.version, "must run with the pinned Node version");
  assert.equal(sha256(await readFile(process.execPath)), NODE.sha256, "pinned Node binary changed");
  const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  assert.equal(head.trim(), EXPECTED_HEAD, "integration checkout HEAD changed");
  const dependencyRootInfo = await assertRealDirectory(DEPENDENCY_ROOT, "pinned dependency root", 0o700);
  assert.ok(dependencyRootInfo.isDirectory());
  const lockPath = resolve(DEPENDENCY_ROOT, ".package-lock.json");
  const lockInfo = await lstat(lockPath);
  assert.ok(lockInfo.isFile() && !lockInfo.isSymbolicLink(), "pinned dependency lock must be a regular file");
  const lockBytes = await readFile(lockPath);
  assert.equal(sha256(lockBytes), DEPENDENCY_LOCK_SHA256, "pinned dependency lock changed");

  const helpers = [];
  for (const [path, expectedHash] of HELPER_PINS) {
    const absolute = resolve(repoRoot, path);
    const info = await lstat(absolute);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `export helper must be a regular file: ${path}`);
    const bytes = await readFile(absolute);
    assert.equal(sha256(bytes), expectedHash, `export helper changed: ${path}`);
    helpers.push({ path, size: bytes.length, sha256: expectedHash });
  }
  const selfPath = fileURLToPath(import.meta.url);
  const selfBytes = await readFile(selfPath);
  return {
    node: { path: NODE.path, version: NODE.version, sha256: NODE.sha256 },
    integrationHead: head.trim(),
    dependency: {
      root: DEPENDENCY_ROOT,
      sourceTreeSha256: DEPENDENCY_SOURCE_SHA256,
      ownedTreeSha256: DEPENDENCY_OWNED_SHA256,
      lockSha256: DEPENDENCY_LOCK_SHA256,
    },
    helpers: [...helpers, { path: relative(repoRoot, selfPath).split(sep).join("/"), size: selfBytes.length, sha256: sha256(selfBytes) }],
  };
}

async function writeJsonExclusive(path, value, mode = 0o600) {
  const file = await open(path, "wx", mode);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function freezeCandidate(preview) {
  await assertAbsent(CANDIDATE_ROOT, "candidate source freeze");
  await mkdir(CANDIDATE_ROOT, { recursive: false, mode: 0o700 });
  await mkdir(CANDIDATE_SOURCE_ROOT, { recursive: false, mode: 0o700 });
  const copiedFiles = [];
  for (const root of preview.roots) {
    const destinationRoot = resolve(CANDIDATE_SOURCE_ROOT, root.destination);
    await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
    for (const entry of root.entries) {
      const sourcePath = resolve(root.sourceRoot, entry.path);
      const relativePath = `${root.destination}/${entry.path}`;
      const destinationPath = resolve(CANDIDATE_SOURCE_ROOT, relativePath);
      assert.ok(destinationPath.startsWith(`${CANDIDATE_SOURCE_ROOT}${sep}`), `candidate path escaped: ${relativePath}`);
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
      const sourceInfo = await lstat(sourcePath);
      assert.ok(sourceInfo.isFile() && !sourceInfo.isSymbolicLink(), `live source changed type: ${relativePath}`);
      const sourceBytes = await readFile(sourcePath);
      assert.equal(sha256(sourceBytes), entry.sha256, `live source changed during freeze: ${relativePath}`);
      await copyFile(sourcePath, destinationPath);
      await chmod(destinationPath, 0o444);
      assert.equal(sha256(await readFile(destinationPath)), entry.sha256, `frozen copy differs: ${relativePath}`);
      copiedFiles.push({ path: relativePath, size: entry.size, sha256: entry.sha256 });
    }
  }
  copiedFiles.sort((left, right) => left.path.localeCompare(right.path));
  assert.equal(copiedFiles.length, CANDIDATE_FILE_COUNT);
  assert.equal(hashJson(preview.roots.map(({ name, destination, sha256: rootSha }) => ({ name, destination, sha256: rootSha }))), CANDIDATE_SOURCE_DIGEST);

  const shaMap = Object.fromEntries(copiedFiles.map(({ path, sha256: hash }) => [path, hash]));
  const sourceManifest = {
    schemaVersion: 1,
    status: "FROZEN_CURRENT_SOURCE_FOR_STATIC_WEB_EXPORT",
    sourceDigest: preview.digest,
    fileCount: preview.fileCount,
    roots: preview.roots.map(({ name, destination, sourceRoot, sha256: rootSha, fileCount }) => ({
      name, destination, sourceRoot, sha256: rootSha, fileCount,
    })),
    files: copiedFiles,
    selectionPolicy: "same as mobile-web-export.mjs: omit .expo/.git/dist/node_modules, dotenv except .env.example, and credential/secret-named entries",
    noCredentialStateCopied: true,
  };
  const sourceManifestBytes = Buffer.from(`${JSON.stringify(sourceManifest, null, 2)}\n`);
  const shaMapBytes = Buffer.from(`${JSON.stringify(shaMap, null, 2)}\n`);
  const freezeMetadata = {
    schemaVersion: 1,
    status: "CURRENT_SOURCE_FROZEN_FOR_STATIC_EXPORT",
    sourceCommit: EXPECTED_HEAD,
    sourceWorktreeDirty: true,
    sourceDigest: preview.digest,
    sourceFiles: preview.fileCount,
    sourceRoots: sourceManifest.roots,
    selectionPolicy: sourceManifest.selectionPolicy,
    base: {
      label: "073fb5 current-mobile-incremental-home-sessions-20261009-054052",
      sourceDigest: BASE_SOURCE_DIGEST,
      manifestSha256: BASE_MANIFEST_SHA256,
      fileCount: BASE_FILE_COUNT,
    },
    delta: preview.delta,
    sha256MapSha256: sha256(shaMapBytes),
    sourceManifestSha256: sha256(sourceManifestBytes),
    sourceUnchangedDuringFreeze: true,
    copiedSnapshotMatchesLiveSource: true,
    frozenAtUtc: new Date().toISOString(),
  };
  await writeJsonExclusive(resolve(CANDIDATE_ROOT, "sha256.json"), shaMap);
  await writeJsonExclusive(resolve(CANDIDATE_ROOT, "source-manifest.json"), sourceManifest);
  await writeJsonExclusive(resolve(CANDIDATE_ROOT, "metadata.json"), freezeMetadata);

  await makeTreeReadOnly(CANDIDATE_SOURCE_ROOT);
  return { sourceManifest, freezeMetadata, shaMapBytes, sourceManifestBytes };
}

async function makeTreeReadOnly(root) {
  const children = await readdir(root, { withFileTypes: true });
  for (const child of children) {
    const path = resolve(root, child.name);
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink(), `candidate snapshot cannot contain symlink: ${path}`);
    if (info.isDirectory()) await makeTreeReadOnly(path);
    else assert.ok(info.isFile(), `candidate snapshot cannot contain special file: ${path}`);
  }
  await chmod(root, 0o500);
}

async function verifyFrozenCandidate(expectedManifest, expectedMetadata) {
  await assertRealDirectory(CANDIDATE_ROOT, "frozen candidate root", 0o700);
  const metadataBytes = await readFile(resolve(CANDIDATE_ROOT, "metadata.json"));
  const manifestBytes = await readFile(resolve(CANDIDATE_ROOT, "source-manifest.json"));
  const mapBytes = await readFile(resolve(CANDIDATE_ROOT, "sha256.json"));
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const map = JSON.parse(mapBytes.toString("utf8"));
  assert.equal(metadata.sourceDigest, CANDIDATE_SOURCE_DIGEST);
  assert.equal(metadata.sourceFiles, CANDIDATE_FILE_COUNT);
  assert.equal(sha256(manifestBytes), expectedMetadata.sourceManifestSha256);
  assert.equal(sha256(mapBytes), expectedMetadata.sha256MapSha256);
  assert.deepEqual(manifest, expectedManifest);
  assert.deepEqual(metadata, expectedMetadata);
  assert.equal(Object.keys(map).length, CANDIDATE_FILE_COUNT);

  const actualRoots = [];
  for (const root of CANDIDATE_ROOTS) {
    const absoluteRoot = resolve(CANDIDATE_SOURCE_ROOT, root.destination);
    const actual = await collectRoot(absoluteRoot, root.destination);
    assert.equal(actual.fileCount, root.fileCount);
    assert.equal(actual.sha256, root.sha256);
    actualRoots.push({ name: root.name, destination: root.destination, sha256: actual.sha256 });
    for (const entry of actual.entries) {
      const full = `${root.destination}/${entry.path}`;
      assert.equal(map[full], entry.sha256, `frozen file differs from its manifest: ${full}`);
    }
  }
  const digest = hashJson(actualRoots);
  assert.equal(digest, CANDIDATE_SOURCE_DIGEST);
  return { metadata, manifest, sha256MapSha256: sha256(mapBytes), sourceManifestSha256: sha256(manifestBytes) };
}

async function copyBundleExclusive(sourceRoot, destinationRoot, files, expectedBundleSha256) {
  await assertAbsent(destinationRoot, "portable Web bundle destination");
  await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  const copied = [];
  for (const entry of files) {
    const relativePath = safeRelativePath(entry.path);
    const source = resolve(sourceRoot, relativePath);
    const destination = resolve(destinationRoot, relativePath);
    assert.ok(source.startsWith(`${sourceRoot}${sep}`), `bundle source escaped: ${relativePath}`);
    assert.ok(destination.startsWith(`${destinationRoot}${sep}`), `bundle destination escaped: ${relativePath}`);
    const info = await lstat(source);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `export bundle must be a regular file: ${relativePath}`);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const bytes = await readFile(source);
    assert.equal(bytes.length, entry.size, `export file size changed: ${relativePath}`);
    assert.equal(sha256(bytes), entry.sha256, `export file hash changed: ${relativePath}`);
    await copyFile(source, destination);
    await chmod(destination, 0o444);
    copied.push({ path: relativePath, size: bytes.length, sha256: sha256(await readFile(destination)) });
  }
  copied.sort((left, right) => left.path.localeCompare(right.path));
  assert.equal(hashJson(copied), expectedBundleSha256, "portable Web bundle digest differs from the exporter manifest");
  await makeTreeReadOnly(destinationRoot);
  return copied;
}

async function writeRawExclusive(path, bytes, mode = 0o600) {
  const file = await open(path, "wx", mode);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function executeExport(preflight) {
  const base = await verifyBase();
  const currentBefore = await collectCurrent();
  assert.equal(currentBefore.digest, CANDIDATE_SOURCE_DIGEST, "current Mobile/shared source changed after preview");
  assert.equal(currentBefore.fileCount, CANDIDATE_FILE_COUNT);
  const delta = compareCandidate(currentBefore, base.baseMap);
  const inputPinsBefore = await verifyRuntimeInputs();
  const candidate = { sourceManifest: JSON.parse(await readFile(resolve(CANDIDATE_ROOT, "source-manifest.json"), "utf8")), freezeMetadata: JSON.parse(await readFile(resolve(CANDIDATE_ROOT, "metadata.json"), "utf8")) };
  const currentAfterFreeze = await collectCurrent();
  assert.equal(currentAfterFreeze.digest, CANDIDATE_SOURCE_DIGEST, "live source changed during freeze");
  assert.deepEqual(currentAfterFreeze.files, currentBefore.files, "live source file manifest changed during freeze");
  const frozen = await verifyFrozenCandidate(candidate.sourceManifest, candidate.freezeMetadata);

  const result = await runE2E(import.meta.url, {
    actualPrivateDriverPath: fileURLToPath(import.meta.url),
    actualPrivateDriverSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    testId: TEST_ID,
    tier: "full-integration",
    modelPolicy: "static Mobile Web source freeze and Expo Web export only; no Browser, Gateway, Provider, user session, or credential state",
    retainSuccessLogs: true,
    cleanupTimeoutMs: 20_000,
    survivorCheckTimeoutMs: 5_000,
    candidateSourceDigest: CANDIDATE_SOURCE_DIGEST,
    candidateFileCount: CANDIDATE_FILE_COUNT,
    baseSourceDigest: BASE_SOURCE_DIGEST,
    dependencySourceTreeSha256: DEPENDENCY_SOURCE_SHA256,
    nodeVersion: NODE.version,
  }, async context => {
    await context.writeArtifactJson("current-mobile-source-freeze.json", {
      candidateRoot: CANDIDATE_ROOT,
      sourceDigest: frozen.metadata.sourceDigest,
      sourceManifestSha256: frozen.sourceManifestSha256,
      sha256MapSha256: frozen.sha256MapSha256,
      fileCount: CANDIDATE_FILE_COUNT,
      rootCounts: CANDIDATE_ROOTS.map(root => ({ name: root.name, fileCount: root.fileCount, sha256: root.sha256 })),
      delta: preflight.delta,
      credentialStateCopied: false,
    });

    const mobileRoot = resolve(CANDIDATE_SOURCE_ROOT, "apps/kcoder-studio/mobile");
    const sharedRoot = resolve(CANDIDATE_SOURCE_ROOT, "apps/kcoder-studio/shared");
    const exported = await exportMobileWeb(context, {
      mobileRoot,
      sourceRoots: [
        { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
        { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
      ],
      dependencyRoot: DEPENDENCY_ROOT,
      label: "default-catalog-parallel-20261009-090018",
      outputName: "mobile-web-default-catalog-parallel-20261009-090018",
      timeoutMs: 180_000,
    });
    assert.equal(exported.sourceTreeSha256, CANDIDATE_SOURCE_DIGEST, "exporter did not build the exact 339-file freeze");
    assert.equal(exported.dependencySourceTreeSha256, DEPENDENCY_SOURCE_SHA256);
    assert.equal(exported.dependencyOwnedTreeSha256, DEPENDENCY_OWNED_SHA256);
    assert.deepEqual(exported.sourceRoots.map(root => ({ name: root.name, fileCount: root.fileCount })), [
      { name: "mobile", fileCount: 320 },
      { name: "studio-shared", fileCount: 19 },
    ]);

    const exportManifestBytes = await readFile(exported.bundleManifestPath);
    const exportManifest = JSON.parse(exportManifestBytes.toString("utf8"));
    assert.equal(exportManifest.status, "complete", exportManifest.error ?? "Mobile Web export failed");
    assert.equal(exportManifest.sourceUnchanged, true);
    assert.equal(exportManifest.snapshotCopyMatchesSource, true);
    assert.equal(exportManifest.snapshotUnchangedDuringExport, true);
    assert.equal(exportManifest.dependencyProvenance.sourceUnchanged, true);
    assert.equal(exportManifest.terminalHookChangesOnlyGeneratedHtml, true);
    assert.ok(exported.bundleFiles.some(file => file.path === "index.html"));

    await assertAbsent(OUTPUT_ROOT, "portable Web output root");
    await assertAbsent(OUTPUT_MANIFEST, "portable export manifest");
    await assertAbsent(OUTPUT_PROVENANCE, "portable provenance sidecar");
    const bundleFiles = await copyBundleExclusive(
      exported.path,
      OUTPUT_ROOT,
      exported.bundleFiles,
      exported.bundleSha256,
    );
    const currentAfterExport = await collectCurrent();
    assert.equal(currentAfterExport.digest, CANDIDATE_SOURCE_DIGEST, "live Mobile/shared source changed during export");
    assert.deepEqual(currentAfterExport.files, currentBefore.files, "live Mobile/shared source file manifest changed during export");
    const inputPinsAfter = await verifyRuntimeInputs();
    assert.deepEqual(inputPinsAfter, inputPinsBefore, "Node, exporter, or dependency lock changed during export");

    const exportManifestSha256 = sha256(exportManifestBytes);
    await writeRawExclusive(OUTPUT_MANIFEST, exportManifestBytes);

    const provenance = {
      schemaVersion: 1,
      status: "complete",
      purpose: "current Mobile Web static export for incremental Home/Sessions source; no Browser/public relay/native validation",
      checkout: { head: EXPECTED_HEAD, worktreeDirty: true },
      base: {
        label: "073fb5 current-mobile-incremental-home-sessions-20261009-054052",
        sourceDigest: BASE_SOURCE_DIGEST,
        sourceManifestSha256: BASE_MANIFEST_SHA256,
        fileCount: BASE_FILE_COUNT,
      },
      candidate: {
        root: CANDIDATE_ROOT,
        sourceDigest: CANDIDATE_SOURCE_DIGEST,
        sourceManifestSha256: frozen.sourceManifestSha256,
        sha256MapSha256: frozen.sha256MapSha256,
        fileCount: CANDIDATE_FILE_COUNT,
        roots: CANDIDATE_ROOTS.map(root => ({ name: root.name, fileCount: root.fileCount, sha256: root.sha256 })),
        delta: preflight.delta,
        sourceUnchangedBeforeCopy: true,
        copiedSnapshotMatchesLiveSource: true,
        sourceUnchangedAfterExport: true,
        credentialStateCopied: false,
      },
      exporter: {
        helperPath: "apps/kcoder-studio/e2e/harness/mobile-web-export.mjs",
        runContextPath: "apps/kcoder-studio/e2e/harness/run-context.mjs",
        sourceTreeSha256: exported.sourceTreeSha256,
        sourceRoots: exported.sourceRoots,
        sourceUnchanged: exportManifest.sourceUnchanged,
        snapshotCopyMatchesSource: exportManifest.snapshotCopyMatchesSource,
        snapshotUnchangedDuringExport: exportManifest.snapshotUnchangedDuringExport,
        terminalHookChangesOnlyGeneratedHtml: exportManifest.terminalHookChangesOnlyGeneratedHtml,
        exporterManifestSha256: exportManifestSha256,
        exporterManifestPath: exported.bundleManifestPath,
      },
      dependencies: {
        sourceTreeSha256: exported.dependencySourceTreeSha256,
        ownedTreeSha256: exported.dependencyOwnedTreeSha256,
        lockSha256: DEPENDENCY_LOCK_SHA256,
        unchanged: exportManifest.dependencyProvenance.sourceUnchanged,
      },
      bundle: {
        root: OUTPUT_ROOT,
        manifestPath: OUTPUT_MANIFEST,
        manifestSha256: exportManifestSha256,
        provenancePath: OUTPUT_PROVENANCE,
        bundleSha256: exported.bundleSha256,
        fileCount: bundleFiles.length,
        indexHtmlSha256: exported.indexHtmlSha256,
      },
      runtimePins: inputPinsAfter,
      validationBoundary: "Expo Web export only. No Browser, Gateway, Provider, actual.env, credentials.json, storageState, user session, public network, or native runtime was used.",
    };
    await writeJsonExclusive(OUTPUT_PROVENANCE, provenance);
    await context.writeArtifactJson("mobile-web-export-portable-provenance.json", provenance);

    return {
      status: "static-mobile-web-export-complete",
      baseSourceDigest: BASE_SOURCE_DIGEST,
      candidateSourceDigest: exported.sourceTreeSha256,
      candidateFileCount: CANDIDATE_FILE_COUNT,
      candidateDelta: preflight.delta,
      dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
      bundleSha256: exported.bundleSha256,
      bundleFileCount: bundleFiles.length,
      indexHtmlSha256: exported.indexHtmlSha256,
      bundlePath: OUTPUT_ROOT,
      manifestPath: OUTPUT_MANIFEST,
      provenancePath: OUTPUT_PROVENANCE,
      exporterManifestSha256: exportManifestSha256,
      exporterPids: {
        dependencyCopier: exported.dependencyCopierPid,
        terminalHtmlBuilder: exported.terminalWebView.builderPid,
        expoExporter: exportManifest.exporterPid,
      },
    };
  });
  return result;
}

async function main() {
  assert.ok(process.argv.length === 3 && ['--freeze','--execute'].includes(process.argv[2]), 'explicit --freeze or --execute required');
  const runtimePins = await verifyRuntimeInputs();
  const base = await verifyBase();
  const current = await collectCurrent();
  assert.equal(current.digest,CANDIDATE_SOURCE_DIGEST);
  assert.equal(current.fileCount,CANDIDATE_FILE_COUNT);
  const delta=compareCandidate(current,base.baseMap);
  if(process.argv[2] === '--freeze') {
    const candidate=await freezeCandidate({...current,delta});
    const after=await collectCurrent();
    assert.deepEqual(after.files,current.files);
    const frozen=await verifyFrozenCandidate(candidate.sourceManifest,candidate.freezeMetadata);
    console.log(JSON.stringify({status:'SOURCE_FROZEN_NOT_EXPORTED',candidateRoot:CANDIDATE_ROOT,payloadRoot:CANDIDATE_SOURCE_ROOT,fileCount:CANDIDATE_FILE_COUNT,sourceDigest:CANDIDATE_SOURCE_DIGEST,manifestSha256:frozen.sourceManifestSha256,sha256MapSha256:frozen.sha256MapSha256,delta,runtimePins},null,2));
    return;
  }
  await assertAbsent(OUTPUT_ROOT,'portable Web output root');
  await assertAbsent(OUTPUT_MANIFEST,'portable export manifest');
  await assertAbsent(OUTPUT_PROVENANCE,'portable provenance sidecar');
  await executeExport({...current,delta});
}
await main();
