// One-off static Mobile Web export from an immutable source freeze.
// Model, Gateway, Browser, and user-session behavior are outside this build.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, runE2E } from "../harness/run-context.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";

const BASE_COMMIT = "09d1e88342909b36237a571774d2987fa2a8556c";
const CANDIDATE_RELATIVE_ROOT =
  "target/private-phone-ux-implementation/mobile-web-export-durable-task-handoff-static02-20261008";
const CANDIDATE_ROOT = resolve(repoRoot, CANDIDATE_RELATIVE_ROOT);
const SOURCE_ROOT = resolve(CANDIDATE_ROOT, "source");
const SOURCE_FILES_PATH = resolve(CANDIDATE_ROOT, "source-files.json");
const SOURCE_METADATA_PATH = resolve(CANDIDATE_ROOT, "metadata.json");
const ORIGIN_STATIC02_PATH = resolve(CANDIDATE_ROOT, "origin-static02-manifest.json");
const ORIGIN_BASELINE14_PATH = resolve(CANDIDATE_ROOT, "origin-mobile-family-before14-manifest.json");
const OVERLAY_DIFF_PATH = resolve(CANDIDATE_ROOT, "overlay.diff");
const CANDIDATE_SOURCE_DIGEST = "8623b4e873e21303b40ea1f04b7107fd67a54f746ac328515542bf6ffee79892";
const SOURCE_FILES_SHA256 = "4b3b654f3dfe71a277a90422fa50a082ae05fb4947e697c4e5c7f57c3246c780";
const SOURCE_METADATA_SHA256 = "0286ded13b939229b764f192d8fd783d2ccdc900e33f8a934765c9d74f4b3406";
const STATIC02_MANIFEST_SHA256 = "eefa10c8b2ea3badbea9ecfde001c4acccc7c901a3dfc95e53b0289aec30930c";
const BASELINE14_MANIFEST_SHA256 = "6807e1cc7d1f376e22bf2857fb1e460c9adb8fa47c45f22ef2610dd53e45f40d";
const OVERLAY_DIFF_SHA256 = "3ebfd29f7acdae075f3e27195f6526be9d2e39909215b0408bd033fca073c8a9";
const CANDIDATE_FILE_COUNT = 315;
const MOBILE_FILE_COUNT = 296;
const SHARED_FILE_COUNT = 19;
const CANDIDATE_SOURCE_ROOTS = [
  {
    name: "mobile",
    path: resolve(SOURCE_ROOT, "apps/kcoder-studio/mobile"),
    destination: "apps/kcoder-studio/mobile",
  },
  {
    name: "studio-shared",
    path: resolve(SOURCE_ROOT, "apps/kcoder-studio/shared"),
    destination: "apps/kcoder-studio/shared",
  },
];
const EXPORT_HELPER_PINS = new Map([
  ["apps/kcoder-studio/e2e/harness/mobile-web-export.mjs", "fbbd2ed8591c8c22cf6c683b024d647610b9df6e568c300ffb1acc13fbbe4b36"],
  ["apps/kcoder-studio/e2e/harness/run-context.mjs", "94f0c27306f8944cbd10f1835227a408c51a0b558981d846832bb297c5e5cf11"],
  ["apps/kcoder-studio/e2e/harness/retention.mjs", "9df5193dc1f4bd5565731cf92d0154bb8f3993e8d3c7c3d98f530c8738716532"],
  ["apps/kcoder-studio/e2e/harness/owned-process.mjs", "40a230721ead1ff78877c1b2815aafd220279bccd43d15d78303f30a59cb78af"],
]);
const NODE_PIN = {
  executable: "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node",
  version: "v22.17.0",
  sha256: "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9",
};
const DEPENDENCY_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/private-phone-ux-implementation/mobile-dependency-input-pinned";
const DEPENDENCY_SOURCE_SHA256 = "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c";
const DEPENDENCY_LOCK_SHA256 = "67c2d1c16857f0ed0f6d2ecb3dcf753f26a268b0f1675c1553018e37e9d231a3";
const DEPENDENCY_OWNED_SHA256 = "754d1db10bd502faeb0b6e82820d455cae680166008a443f7397457f1ef21d29";
const PORTABLE_ROOT = resolve(CANDIDATE_ROOT, "export");
const PORTABLE_MANIFEST_PATH = resolve(CANDIDATE_ROOT, "export-manifest.json");
const PORTABLE_PROVENANCE_PATH = resolve(CANDIDATE_ROOT, "export-provenance.json");
const SOURCE_OMITTED_DIRECTORIES = new Set([".expo", ".git", "dist", "node_modules"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function shouldOmitSourceEntry(name) {
  if (SOURCE_OMITTED_DIRECTORIES.has(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  return /(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name);
}

async function readRegularFile(path, label) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  return readFile(path);
}

async function readFrozenFile(path, label) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  assert.equal(info.mode & 0o222, 0, `${label} must remain read-only`);
  return readFile(path);
}

async function assertDirectory(path, expectedMode, label) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a directory`);
  assert.equal(await realpath(path), path, `${label} must not traverse a symlink`);
  if (expectedMode !== undefined) assert.equal(info.mode & 0o777, expectedMode, `${label} mode changed`);
  if (typeof process.getuid === "function") assert.equal(info.uid, process.getuid(), `${label} owner changed`);
  return info;
}

async function collectSourceRoot(root) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = resolve(directory, child.name);
      const relativePath = relative(root.path, absolutePath).split(sep).join("/");
      const info = await lstat(absolutePath);
      assert.ok(!info.isSymbolicLink(), `frozen Mobile source contains a symlink: ${relativePath}`);
      assert.equal(info.mode & 0o222, 0, `frozen Mobile source is writable: ${relativePath}`);
      if (shouldOmitSourceEntry(child.name)) continue;
      if (info.isDirectory()) {
        await visit(absolutePath);
      } else if (info.isFile()) {
        const bytes = await readFile(absolutePath);
        entries.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
      } else {
        throw new Error(`frozen Mobile source contains a special file: ${relativePath}`);
      }
    }
  }
  await visit(root.path);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

async function verifyCandidate() {
  await assertDirectory(CANDIDATE_ROOT, 0o700, "frozen Mobile source candidate root");
  await assertDirectory(SOURCE_ROOT, 0o555, "frozen Mobile source tree");

  const [metadataBytes, filesBytes, staticBytes, baselineBytes, diffBytes] = await Promise.all([
    readFrozenFile(SOURCE_METADATA_PATH, "candidate metadata"),
    readFrozenFile(SOURCE_FILES_PATH, "candidate file manifest"),
    readFrozenFile(ORIGIN_STATIC02_PATH, "historical static02 manifest copy"),
    readFrozenFile(ORIGIN_BASELINE14_PATH, "historical 14-file baseline manifest copy"),
    readFrozenFile(OVERLAY_DIFF_PATH, "Mobile source overlay diff"),
  ]);
  assert.equal(sha256(metadataBytes), SOURCE_METADATA_SHA256, "candidate metadata changed");
  assert.equal(sha256(filesBytes), SOURCE_FILES_SHA256, "candidate source manifest changed");
  assert.equal(sha256(staticBytes), STATIC02_MANIFEST_SHA256, "historical static02 manifest copy changed");
  assert.equal(sha256(baselineBytes), BASELINE14_MANIFEST_SHA256, "historical baseline manifest copy changed");
  assert.equal(sha256(diffBytes), OVERLAY_DIFF_SHA256, "Mobile source overlay diff changed");

  const metadata = JSON.parse(metadataBytes);
  const fileManifest = JSON.parse(filesBytes);
  const staticManifest = JSON.parse(staticBytes);
  const baselineManifest = JSON.parse(baselineBytes);
  assert.equal(metadata.status, "FROZEN_SOURCE_ONLY_NOT_EXPORTED");
  assert.equal(metadata.baseCommit, BASE_COMMIT);
  assert.equal(metadata.sourceDigest, CANDIDATE_SOURCE_DIGEST);
  assert.equal(metadata.exportSourceFileCount, CANDIDATE_FILE_COUNT);
  assert.equal(metadata.overlay.verifiedMobileFileCount, 15);
  assert.equal(metadata.overlay.crossComponentHistoricalPinCount, 3);
  assert.equal(metadata.overlay.staticManifestSha256, STATIC02_MANIFEST_SHA256);
  assert.equal(metadata.overlay.baseline14ManifestSha256, BASELINE14_MANIFEST_SHA256);
  assert.equal(fileManifest.status, "FROZEN_SOURCE_INPUTS_NOT_EXPORTED");
  assert.equal(fileManifest.count, CANDIDATE_FILE_COUNT);
  assert.equal(fileManifest.sourceDigest, CANDIDATE_SOURCE_DIGEST);
  assert.deepEqual(fileManifest.roots.map(({ name, destination, fileCount }) => ({ name, destination, fileCount })), [
    { name: "mobile", destination: "apps/kcoder-studio/mobile", fileCount: MOBILE_FILE_COUNT },
    { name: "studio-shared", destination: "apps/kcoder-studio/shared", fileCount: SHARED_FILE_COUNT },
  ]);

  const staticPaths = new Set(staticManifest.files.map(file => file.path));
  const baselinePaths = new Set(baselineManifest.files.map(file => file.path));
  const productPaths = new Set(staticManifest.productScope);
  const unionPaths = new Set([...baselinePaths, ...productPaths]);
  assert.equal(staticManifest.count, 18);
  assert.equal(staticManifest.changedCount, 8);
  assert.equal(baselineManifest.count, 14);
  assert.equal(unionPaths.size, 18);
  assert.deepEqual([...unionPaths].sort(), [...staticPaths].sort(), "baseline and product scopes must equal the static02 source union");
  const mobileOverlay = staticManifest.files.filter(file => file.path.startsWith("apps/kcoder-studio/mobile/"));
  assert.equal(mobileOverlay.length, 15);

  const expectedFiles = new Map(fileManifest.files.map(file => [file.path, file]));
  assert.equal(expectedFiles.size, CANDIDATE_FILE_COUNT, "candidate file manifest has duplicate paths");
  const actualRoots = [];
  for (const root of CANDIDATE_SOURCE_ROOTS) {
    await assertDirectory(root.path, 0o555, `${root.name} frozen source root`);
    const actual = await collectSourceRoot(root);
    const fullEntries = actual.map(entry => ({
      ...entry,
      path: `${root.destination}/${entry.path}`,
    }));
    for (const entry of fullEntries) {
      const expected = expectedFiles.get(entry.path);
      assert.ok(expected, `unexpected source file in candidate: ${entry.path}`);
      assert.deepEqual(entry, expected, `source file differs from the immutable candidate manifest: ${entry.path}`);
    }
    assert.equal(fullEntries.length, root.name === "mobile" ? MOBILE_FILE_COUNT : SHARED_FILE_COUNT);
    actualRoots.push({
      name: root.name,
      path: root.path,
      destination: root.destination,
      sha256: hashJson(actual),
      fileCount: actual.length,
    });
  }
  assert.equal(expectedFiles.size, actualRoots.reduce((total, root) => total + root.fileCount, 0));
  const sourceDigest = hashJson(actualRoots.map(({ name, destination, sha256: treeSha256 }) => ({
    name,
    destination,
    sha256: treeSha256,
  })));
  assert.equal(sourceDigest, CANDIDATE_SOURCE_DIGEST, "candidate source roots differ from the frozen source digest");

  for (const overlay of mobileOverlay) {
    const candidate = expectedFiles.get(overlay.path);
    assert.ok(candidate, `one of the 15 Mobile overlay files is missing: ${overlay.path}`);
    assert.equal(candidate.sha256, overlay.sha256, `Mobile overlay pin changed: ${overlay.path}`);
  }
  const packageLock = expectedFiles.get("apps/kcoder-studio/mobile/package-lock.json");
  assert.ok(packageLock, "Mobile package-lock.json must remain in the exported input");
  assert.equal(packageLock.sha256, "848076f520f165128b601b27d96d4d32cf25e8929ee54b672f198b9a4c224e26");
  assert.deepEqual(fileManifest.excludedByExportFilter.map(item => item.path), [
    "apps/kcoder-studio/mobile/src/storage/device-secret-binding.test.ts",
  ]);
  return { metadata, fileManifest, staticManifest, sourceDigest, actualRoots, mobileOverlay };
}

async function verifyRuntimePins() {
  assert.equal(process.execPath, NODE_PIN.executable, "export must use the pinned Node binary");
  assert.equal(process.version, NODE_PIN.version, "export must use the pinned Node version");
  assert.equal(sha256(await readFile(process.execPath)), NODE_PIN.sha256, "Node binary changed");

  const dependencyInfo = await assertDirectory(DEPENDENCY_ROOT, 0o700, "pinned Mobile dependency root");
  assert.ok(dependencyInfo.isDirectory());
  assert.equal(await realpath(DEPENDENCY_ROOT), DEPENDENCY_ROOT, "dependency root must not traverse a symlink");
  assert.equal(
    sha256(await readRegularFile(resolve(DEPENDENCY_ROOT, ".package-lock.json"), "pinned dependency lock")),
    DEPENDENCY_LOCK_SHA256,
    "pinned dependency package lock changed",
  );
  const dependencySourceSha256 = await hashDependencySourceTree();
  assert.equal(dependencySourceSha256, DEPENDENCY_SOURCE_SHA256, "pinned dependency tree changed before export");
  const wrapperPath = fileURLToPath(import.meta.url);
  const wrapperSha256 = sha256(await readRegularFile(wrapperPath, "export runner source"));
  const helperFiles = [];
  for (const [path, expectedSha256] of EXPORT_HELPER_PINS) {
    const bytes = await readRegularFile(resolve(repoRoot, path), `pinned E2E helper ${path}`);
    const actualSha256 = sha256(bytes);
    assert.equal(actualSha256, expectedSha256, `E2E helper changed: ${path}`);
    helperFiles.push({ path, sha256: actualSha256 });
  }
  return {
    node: { ...NODE_PIN },
    dependency: {
      root: DEPENDENCY_ROOT,
      packageLockSha256: DEPENDENCY_LOCK_SHA256,
      sourceTreeSha256: dependencySourceSha256,
      priorOwnedTreeSha256: DEPENDENCY_OWNED_SHA256,
      copiedFileCount: 52_252,
    },
    wrapper: { path: relative(repoRoot, wrapperPath).split(sep).join("/"), sha256: wrapperSha256 },
    helpers: helperFiles,
  };
}

async function hashDependencySourceTree() {
  const root = await realpath(DEPENDENCY_ROOT);
  const files = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = resolve(directory, child.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        files.push({ path: relativePath, type: "symlink", target: await readlink(absolutePath) });
      } else if (info.isDirectory()) {
        await visit(absolutePath);
      } else if (info.isFile()) {
        const bytes = await readFile(absolutePath);
        files.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return hashJson([{
    name: "mobile-dependencies",
    destination: "apps/kcoder-studio/mobile/node_modules",
    sha256: hashJson(files),
  }]);
}

async function assertAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists; refusing to reuse or overwrite prior bytes`);
}

async function collectArtifactTree(root) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = resolve(directory, child.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      const info = await lstat(absolutePath);
      assert.ok(!info.isSymbolicLink(), `generated export contains a symlink: ${relativePath}`);
      if (info.isDirectory()) {
        await visit(absolutePath);
      } else if (info.isFile()) {
        const bytes = await readFile(absolutePath);
        entries.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
      } else {
        throw new Error(`generated export contains a special file: ${relativePath}`);
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { files: entries, sha256: hashJson(entries) };
}

async function copyArtifactTree(sourceRoot, destinationRoot, { rootAlreadyCreated = false } = {}) {
  if (rootAlreadyCreated) {
    const rootInfo = await lstat(destinationRoot);
    assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "pre-created portable export root must be a real directory");
    assert.equal((await readdir(destinationRoot)).length, 0, "pre-created portable export root must be empty");
  } else {
    await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  }
  async function visit(source, destination) {
    const children = await readdir(source, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const sourcePath = resolve(source, child.name);
      const destinationPath = resolve(destination, child.name);
      assert.ok(destinationPath.startsWith(`${destinationRoot}${sep}`), "portable export path escaped its owned root");
      const info = await lstat(sourcePath);
      assert.ok(!info.isSymbolicLink(), `generated export contains a symlink: ${child.name}`);
      if (info.isDirectory()) {
        await mkdir(destinationPath, { recursive: false, mode: 0o700 });
        await visit(sourcePath, destinationPath);
      } else if (info.isFile()) {
        await copyFile(sourcePath, destinationPath);
      } else {
        throw new Error(`generated export contains a special file: ${child.name}`);
      }
    }
  }
  await visit(sourceRoot, destinationRoot);
}

async function freezeArtifactTree(path) {
  const info = await lstat(path);
  assert.ok(!info.isSymbolicLink(), "portable export cannot contain symlinks");
  if (info.isDirectory()) {
    for (const child of await readdir(path)) await freezeArtifactTree(resolve(path, child));
    await chmod(path, 0o555);
  } else if (info.isFile()) {
    await chmod(path, (info.mode & 0o111) ? 0o555 : 0o444);
  } else {
    throw new Error(`portable export contains a special file: ${path}`);
  }
}

async function writeExclusive(path, bytes, createdSidecars) {
  const handle = await open(path, "wx", 0o600);
  const info = await handle.stat();
  createdSidecars.push({ path, dev: info.dev, ino: info.ino });
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o444);
}

async function removeOwnedSidecar(entry) {
  let info;
  try {
    info = await lstat(entry.path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.ok(info.isFile() && !info.isSymbolicLink(), "refusing to remove a changed portable sidecar");
  assert.equal(info.dev, entry.dev, "portable sidecar device identity changed");
  assert.equal(info.ino, entry.ino, "portable sidecar inode identity changed");
  await rm(entry.path);
}

async function removeOwnedPortableRoot(identity) {
  if (!identity) return;
  let info;
  try {
    info = await lstat(PORTABLE_ROOT);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), "refusing to remove a changed portable export root");
  assert.equal(info.dev, identity.dev, "portable export device identity changed");
  assert.equal(info.ino, identity.ino, "portable export inode identity changed");
  async function makeWritable(path) {
    const entry = await lstat(path);
    assert.ok(!entry.isSymbolicLink(), "refusing to traverse a changed portable export tree");
    if (entry.isDirectory()) {
      for (const child of await readdir(path)) await makeWritable(resolve(path, child));
      await chmod(path, 0o700);
    } else if (entry.isFile()) {
      await chmod(path, 0o600);
    } else {
      throw new Error("refusing to remove a special file from portable export cleanup");
    }
  }
  await makeWritable(PORTABLE_ROOT);
  await rm(PORTABLE_ROOT, { recursive: true });
}

await runE2E(
  import.meta.url,
  {
    testId: "mobile-web-export-durable-task-handoff-static02",
    tier: "full-integration",
    modelPolicy: "model-independent static Mobile Web export only; no Browser, Gateway, Provider, or user session",
    retainSuccessLogs: true,
    cleanupTimeoutMs: 20_000,
    survivorCheckTimeoutMs: 5_000,
  },
  async context => {
    const createdSidecars = [];
    let portableRootIdentity = null;
    try {
      const candidate = await verifyCandidate();
      const pins = await verifyRuntimePins();
      await assertAbsent(PORTABLE_ROOT, "portable Mobile Web output");
      await assertAbsent(PORTABLE_MANIFEST_PATH, "portable Mobile Web manifest");
      await assertAbsent(PORTABLE_PROVENANCE_PATH, "portable Mobile Web provenance");

      await context.writeArtifactJson("build-inputs.json", {
        status: "preflight-passed",
        sourceStatus: "FROZEN_SOURCE_INPUTS_NOT_EXPORTED",
        baseCommit: BASE_COMMIT,
        candidateRoot: CANDIDATE_ROOT,
        candidateSourceRoot: SOURCE_ROOT,
        candidateSourceDigest: candidate.sourceDigest,
        candidateFileManifestSha256: SOURCE_FILES_SHA256,
        candidateMetadataSha256: SOURCE_METADATA_SHA256,
        candidateFileCount: CANDIDATE_FILE_COUNT,
        sourceRootFiles: { mobile: MOBILE_FILE_COUNT, shared: SHARED_FILE_COUNT },
        static02ManifestSha256: STATIC02_MANIFEST_SHA256,
        baseline14ManifestSha256: BASELINE14_MANIFEST_SHA256,
        mobileOverlayFiles: candidate.mobileOverlay.map(({ path, sha256: fileSha256 }) => ({ path, sha256: fileSha256 })),
        historicalCrossComponentPins: candidate.metadata.overlay.crossComponentHistoricalPins,
        sourceRoots: candidate.actualRoots,
        exporter: pins,
        portableRoot: PORTABLE_ROOT,
      });

      const exported = await exportMobileWeb(context, {
        mobileRoot: CANDIDATE_SOURCE_ROOTS[0].path,
        sourceRoots: CANDIDATE_SOURCE_ROOTS,
        dependencyRoot: DEPENDENCY_ROOT,
        label: "durable-task-handoff-static02",
        outputName: "mobile-web-export-durable-task-handoff-static02",
        timeoutMs: 180_000,
      });
      assert.equal(exported.sourceTreeSha256, CANDIDATE_SOURCE_DIGEST, "export helper saw a different frozen source tree");
      assert.equal(exported.sourceRoots.find(root => root.name === "mobile")?.fileCount, MOBILE_FILE_COUNT);
      assert.equal(exported.sourceRoots.find(root => root.name === "studio-shared")?.fileCount, SHARED_FILE_COUNT);
      assert.equal(exported.dependencySourceTreeSha256, DEPENDENCY_SOURCE_SHA256);
      assert.equal(exported.dependencyOwnedTreeSha256, DEPENDENCY_OWNED_SHA256);

      const bundleManifest = JSON.parse(await readFile(exported.bundleManifestPath, "utf8"));
      assert.equal(bundleManifest.status, "complete", bundleManifest.error ?? "Mobile Web export failed");
      assert.equal(bundleManifest.sourceUnchanged, true);
      assert.equal(bundleManifest.snapshotCopyMatchesSource, true);
      assert.equal(bundleManifest.snapshotUnchangedDuringExport, true);
      assert.equal(bundleManifest.dependencyProvenance.sourceUnchanged, true);
      assert.equal(bundleManifest.terminalHookChangesOnlyGeneratedHtml, true);
      assert.ok(exported.bundleFiles.some(file => file.path === "index.html"), "Mobile Web export is missing index.html");

      await mkdir(PORTABLE_ROOT, { recursive: false, mode: 0o700 });
      const portableInfo = await assertDirectory(PORTABLE_ROOT, 0o700, "new portable Mobile Web output");
      portableRootIdentity = { dev: portableInfo.dev, ino: portableInfo.ino };
      await copyArtifactTree(exported.path, PORTABLE_ROOT, { rootAlreadyCreated: true });
      const copiedBundle = await collectArtifactTree(PORTABLE_ROOT);
      assert.deepEqual(copiedBundle.files, exported.bundleFiles, "portable Mobile Web output differs from the RunContext export");
      assert.equal(copiedBundle.sha256, exported.bundleSha256);
      assert.equal(copiedBundle.files.length, exported.bundleFileCount);
      const indexHtmlSha256 = copiedBundle.files.find(file => file.path === "index.html")?.sha256;
      assert.ok(indexHtmlSha256, "portable Mobile Web output is missing index.html");
      await writeExclusive(PORTABLE_MANIFEST_PATH, await readFile(exported.bundleManifestPath), createdSidecars);
      const provenance = {
        status: "complete",
        kind: "private-copy-of-mobile-web-export-v1",
        exportPerformedInMeasurementRun: false,
        wrapperSource: relative(repoRoot, fileURLToPath(import.meta.url)).split(sep).join("/"),
        wrapperSourceSha256: pins.wrapper.sha256,
        sourceCommit: BASE_COMMIT,
        candidateRoot: CANDIDATE_ROOT,
        candidateSourceDigest: candidate.sourceDigest,
        candidateFileManifestSha256: SOURCE_FILES_SHA256,
        candidateMetadataSha256: SOURCE_METADATA_SHA256,
        static02ManifestSha256: STATIC02_MANIFEST_SHA256,
        baseline14ManifestSha256: BASELINE14_MANIFEST_SHA256,
        mobileOverlayFiles: candidate.mobileOverlay.map(({ path, sha256: fileSha256 }) => ({ path, sha256: fileSha256 })),
        sourceRoots: exported.sourceRoots,
        sourceUnchanged: bundleManifest.sourceUnchanged,
        snapshotCopyMatchesSource: bundleManifest.snapshotCopyMatchesSource,
        snapshotUnchangedDuringExport: bundleManifest.snapshotUnchangedDuringExport,
        dependency: {
          root: DEPENDENCY_ROOT,
          packageLockSha256: DEPENDENCY_LOCK_SHA256,
          sourceTreeSha256: exported.dependencySourceTreeSha256,
          ownedTreeSha256: exported.dependencyOwnedTreeSha256,
          sourceUnchanged: bundleManifest.dependencyProvenance.sourceUnchanged,
        },
        node: pins.node,
        exporterPids: {
          dependencyCopier: exported.dependencyCopierPid,
          terminalHtmlBuilder: exported.terminalWebView.builderPid,
          expoExporter: bundleManifest.exporterPid,
        },
        bundlePath: PORTABLE_ROOT,
        bundleSha256: copiedBundle.sha256,
        bundleFileCount: copiedBundle.files.length,
        indexHtmlSha256,
        bundleManifestPath: PORTABLE_MANIFEST_PATH,
        portableProvenancePath: PORTABLE_PROVENANCE_PATH,
      };
      await writeExclusive(PORTABLE_PROVENANCE_PATH, Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`), createdSidecars);
      await context.writeArtifactJson("portable-export-provenance.json", provenance);
      await freezeArtifactTree(PORTABLE_ROOT);
      return {
        candidateSourceDigest: candidate.sourceDigest,
        sourceTreeSha256: exported.sourceTreeSha256,
        dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
        dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
        bundleSha256: copiedBundle.sha256,
        bundleFileCount: copiedBundle.files.length,
        indexHtmlSha256,
        bundlePath: PORTABLE_ROOT,
        bundleManifestPath: PORTABLE_MANIFEST_PATH,
        provenancePath: PORTABLE_PROVENANCE_PATH,
      };
    } catch (error) {
      const cleanupErrors = [];
      for (const sidecar of createdSidecars.reverse()) {
        await removeOwnedSidecar(sidecar).catch(cleanupError => cleanupErrors.push(cleanupError));
      }
      await removeOwnedPortableRoot(portableRootIdentity).catch(cleanupError => cleanupErrors.push(cleanupError));
      if (cleanupErrors.length) {
        throw new AggregateError([error, ...cleanupErrors], "Mobile Web export failed and owned portable output cleanup also failed");
      }
      throw error;
    }
  },
);
