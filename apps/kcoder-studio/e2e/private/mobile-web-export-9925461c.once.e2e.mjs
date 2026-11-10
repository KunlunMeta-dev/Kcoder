import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { appRoot, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const ENABLE = "KCODER_E2E_MOBILE_EXPORT_9925461C";
const SOURCE_COMMIT = "9925461ca047031f3f7f37d1f039d986c305fec3";
const MOBILE_RELATIVE = "apps/kcoder-studio/mobile";
const SHARED_RELATIVE = "apps/kcoder-studio/shared";
const EXPECTED_TREES = {
  [MOBILE_RELATIVE]: "80d41cf2979f7dab00973c6dd6e45e173734d112",
  [SHARED_RELATIVE]: "8270e871236a15579a2302e4b46f35642837b1be",
};
const FREEZE_ROOT = resolve(repoRoot, "target/private-phone-ux-validation/mobile-web-export-9925461c-input-20261009");
const FREEZE_PATH = resolve(FREEZE_ROOT, "source-freeze.json");
const FREEZE_SHA256 = "97e63d0b0614787e8b84369e4c6d15c3d3387884e4595a00867f0dbfe3d544f7";
const ARCHIVE_PATH = resolve(FREEZE_ROOT, "source-9925461c.tar");
const ARCHIVE_SHA256 = "310b5157ff98b8707a43be1b578d2431b6714a582ea5b655432f836a5e6d5b9a";
const MOBILE_LOCK_SHA256 = "7c47b7ad5427ac56682f19c6fb7e46cff6e442ad8f52edee283665a38cd2e68b";
const DEPENDENCY_ROOT_INPUT = resolve(appRoot, "mobile/node_modules");
const EXPECTED_DEPENDENCY_TREE_SHA256 = "46b02fc5ac823118f6eb2c034ea3f1d9cbbf79b71041fc2fa848f79a9abca1c6";
const DEPENDENCY_DESTINATION = "apps/kcoder-studio/mobile/node_modules";
const NODE_PATH = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const NODE_SHA256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const BASE_TOKEN = "/__kcoder_mobile_mount_v1__";
const TERMINAL_HTML = "src/terminal-webview/generated-html.ts";
const TERMINAL_HTML_REPO_PATH = `${MOBILE_RELATIVE}/${TERMINAL_HTML}`;
const BUILD_ROOT_NAME = "mobile-source-9925461c";
const OFFICIAL_DIST_NAME = "official-mobile-dist-9925461c";
const REUSE_BUNDLE_NAME = "mobile-web-bundle-9925461c";
const REUSE_MANIFEST_NAME = "mobile-web-export-reuse-manifest-9925461c.json";
const SOURCE_OMIT_DIRS = new Set([".expo", ".git", "dist", "node_modules"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function comparePath(left, right) {
  return left.localeCompare(right);
}

async function runOwned(context, label, command, args, { cwd, env, timeoutMs = 180_000, captureStdout = false } = {}) {
  const child = context.spawnOwned(label, command, args, { cwd, env, windowsHide: true });
  const chunks = [];
  let byteCount = 0;
  let overflow = false;
  let spawnError = null;
  if (captureStdout) {
    child.stdout?.on("data", chunk => {
      byteCount += chunk.length;
      if (byteCount <= 8 * 1024 * 1024) chunks.push(Buffer.from(chunk));
      else overflow = true;
    });
  }
  child.once("error", error => { spawnError = error; });
  try {
    await waitFor(
      () => spawnError || child.exitCode !== null || child.signalCode !== null,
      timeoutMs,
      `owned ${label}`,
      50,
      context.abortSignal,
    );
    if (spawnError) throw new Error(`${label} could not start: ${spawnError.name}`);
    assert.equal(overflow, false, `${label} stdout exceeded the bounded capture`);
    assert.equal(child.exitCode, 0, `${label} exited with ${child.signalCode || child.exitCode}`);
    return { pid: child.pid ?? null, stdout: captureStdout ? Buffer.concat(chunks) : null };
  } finally {
    await context.stopOwned(label);
  }
}

async function collectTree(root, { sourceOnly = false, omitPaths = new Set() } = {}) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => comparePath(left.name, right.name));
    for (const child of children) {
      if (sourceOnly && shouldOmitSourceEntry(child.name)) continue;
      const absolutePath = resolve(directory, child.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (omitPaths.has(relativePath)) continue;
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        assert.equal(sourceOnly, false, `Mobile source cannot contain symlinks: ${relativePath}`);
        entries.push({ path: relativePath, type: "symlink", target: await readlink(absolutePath) });
      } else if (info.isDirectory()) {
        if (sourceOnly && SOURCE_OMIT_DIRS.has(child.name)) continue;
        await visit(absolutePath);
      } else if (info.isFile()) {
        const bytes = await readFile(absolutePath);
        entries.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
      } else {
        assert.fail(`unexpected file type: ${relativePath}`);
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => comparePath(left.path, right.path));
  return entries;
}

function shouldOmitSourceEntry(name) {
  if (SOURCE_OMIT_DIRS.has(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  return /(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name);
}

async function sourceTree(mobileRoot, sharedRoot, omitTerminal = false) {
  const roots = [
    { name: "mobile", destination: MOBILE_RELATIVE, path: mobileRoot },
    { name: "studio-shared", destination: SHARED_RELATIVE, path: sharedRoot },
  ];
  const hashedRoots = [];
  for (const root of roots) {
    const omitPaths = new Set(omitTerminal && root.name === "mobile" ? [TERMINAL_HTML] : []);
    const files = await collectTree(root.path, { sourceOnly: true, omitPaths });
    hashedRoots.push({
      name: root.name,
      destination: root.destination,
      sha256: hashJson(files),
      fileCount: files.length,
    });
  }
  return {
    roots: hashedRoots,
    sha256: hashJson(hashedRoots.map(({ name, destination, sha256: digest }) => ({ name, destination, sha256: digest }))),
  };
}

async function dependencyTree(root) {
  const entries = await collectTree(root);
  const rootSha256 = hashJson(entries);
  const sha256 = hashJson([{
    name: "mobile-dependencies",
    destination: DEPENDENCY_DESTINATION,
    sha256: rootSha256,
  }]);
  return { sha256, rootSha256, fileCount: entries.length };
}

async function verifyGitArchive(context, sourceRoot, freeze) {
  const { stdout } = await runOwned(context, "174-git-source-inventory", "/usr/bin/git", [
    "ls-tree", "-r", "-z", "--full-tree", SOURCE_COMMIT, "--", MOBILE_RELATIVE, SHARED_RELATIVE,
  ], { cwd: repoRoot, captureStdout: true, timeoutMs: 15_000 });
  const entries = [];
  for (const record of stdout.toString("utf8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    assert.ok(tab > 0, "Git source inventory record is invalid");
    const [mode, type, objectId] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    assert.ok(path.startsWith(`${MOBILE_RELATIVE}/`) || path.startsWith(`${SHARED_RELATIVE}/`));
    assert.ok(mode === "100644" || mode === "100755");
    assert.equal(type, "blob");
    const absolute = resolve(sourceRoot, path);
    const info = await lstat(absolute);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `Git source entry is not a regular file: ${path}`);
    const bytes = await readFile(absolute);
    const blobId = createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
    assert.equal(blobId, objectId, `Git archive blob differs: ${path}`);
    assert.equal(Boolean(info.mode & 0o111), mode === "100755", `Git archive mode differs: ${path}`);
    entries.push({ path, mode, objectId });
  }
  assert.equal(entries.length, freeze.trackedFilesVerified);
  return { trackedFilesVerified: entries.length, gitInventorySha256: sha256(stdout) };
}

async function listRegularFiles(root) {
  const files = [];
  async function visit(directory, prefix = "") {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => comparePath(left.name, right.name));
    for (const child of children) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = resolve(directory, child.name);
      const info = await lstat(absolute);
      assert.ok(!info.isSymbolicLink(), `export contains a symlink: ${path}`);
      if (info.isDirectory()) await visit(absolute, path);
      else {
        assert.ok(info.isFile(), `export contains a special file: ${path}`);
        const bytes = await readFile(absolute);
        files.push({ path, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(root);
  return files;
}

async function assertAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.fail(`${label} already exists; refusing to overwrite it`);
}

async function writeJsonExclusive(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

assert.equal(process.env[ENABLE], "1", `set ${ENABLE}=1 to run this private export`);
assert.equal(process.execPath, NODE_PATH, "use the pinned Node 22.17 executable");
assert.equal(process.version, "v22.17.0");
assert.equal(sha256(await readFile(process.execPath)), NODE_SHA256, "pinned Node binary changed");

await runE2E(import.meta.url, {
  testId: "mobile-web-export-official-9925461c-20261009",
  tier: "model-independent",
  modelPolicy: "none; official Gateway-mountable Mobile Web export from Git 9925461c; no Browser, Gateway, Provider, or turn",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 30_000,
  survivorCheckTimeoutMs: 5_000,
  sourceCommit: SOURCE_COMMIT,
}, async context => {
  const freezeBytes = await readFile(FREEZE_PATH);
  assert.equal(sha256(freezeBytes), FREEZE_SHA256, "9925461c source freeze metadata changed");
  const freeze = JSON.parse(freezeBytes.toString("utf8"));
  assert.equal(freeze.sourceCommit, SOURCE_COMMIT);
  assert.equal(freeze.gitBlobAndModeVerification, "passed");
  assert.equal(freeze.mobilePackageLockSha256, MOBILE_LOCK_SHA256);
  const archiveBytes = await readFile(ARCHIVE_PATH);
  assert.equal(sha256(archiveBytes), ARCHIVE_SHA256, "174 Git archive changed");
  assert.equal(freeze.archive.sha256, ARCHIVE_SHA256);
  assert.deepEqual(freeze.sourceRoots.map(root => [root.path, root.gitTree]), [
    [MOBILE_RELATIVE, EXPECTED_TREES[MOBILE_RELATIVE]],
    [SHARED_RELATIVE, EXPECTED_TREES[SHARED_RELATIVE]],
  ]);

  const dependencyPath = await realpath(DEPENDENCY_ROOT_INPUT);
  const dependencyInfo = await lstat(dependencyPath);
  assert.ok(dependencyInfo.isDirectory() && !dependencyInfo.isSymbolicLink());
  assert.equal(await realpath(resolve(appRoot, "mobile/node_modules")), dependencyPath);
  const dependencyBefore = await dependencyTree(dependencyPath);
  assert.equal(dependencyBefore.sha256, EXPECTED_DEPENDENCY_TREE_SHA256, "verified Mobile dependency tree changed");

  const buildRoot = context.pathInState(BUILD_ROOT_NAME);
  await mkdir(buildRoot, { recursive: false, mode: 0o700 });
  context.registerTemporaryDirectory("Git 174 Mobile/shared build source", buildRoot);
  const archiveInState = context.pathInState("source-9925461c.tar");
  await writeFile(archiveInState, archiveBytes, { flag: "wx", mode: 0o600 });
  const sourceRoot = resolve(buildRoot, "source");
  await mkdir(sourceRoot, { recursive: false, mode: 0o700 });
  const tempDir = context.pathInState("export-tmp");
  await mkdir(tempDir, { recursive: false, mode: 0o700 });
  context.registerTemporaryDirectory("Mobile Web export temporary files", tempDir);
  const env = context.isolatedEnvironment({
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    CI: "1",
    EXPO_NO_TELEMETRY: "1",
    EXPO_NO_DOTENV: "1",
    EXPO_OFFLINE: "1",
    EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP: "0",
    KCODER_STUDIO_ALLOW_HTTP: "0",
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
  });
  await runOwned(context, "174-source-extract", "/usr/bin/tar", [
    "--extract", "--file", archiveInState, "--directory", sourceRoot, "--no-same-owner", "--no-same-permissions",
  ], { cwd: repoRoot, env, timeoutMs: 15_000 });

  const mobileRoot = resolve(sourceRoot, MOBILE_RELATIVE);
  const sharedRoot = resolve(sourceRoot, SHARED_RELATIVE);
  const gitVerification = await verifyGitArchive(context, sourceRoot, freeze);
  const lockBytes = await readFile(resolve(mobileRoot, "package-lock.json"));
  assert.equal(sha256(lockBytes), MOBILE_LOCK_SHA256);
  const mobileNodeModules = resolve(mobileRoot, "node_modules");
  await symlink(dependencyPath, mobileNodeModules, "dir");

  const sourceBefore = await sourceTree(mobileRoot, sharedRoot);
  const sourceBeforeWithoutGenerated = await sourceTree(mobileRoot, sharedRoot, true);
  assert.ok(/^[a-f0-9]{64}$/.test(sourceBefore.sha256));
  const generatedHtml = resolve(mobileRoot, TERMINAL_HTML);
  const generatedHtmlBefore = await readFile(generatedHtml).then(sha256);
  await chmod(generatedHtml, 0o600);
  const nodeHash = sha256(await readFile(process.execPath));
  const terminalBuilder = await runOwned(context, "174-terminal-webview-build", NODE_PATH,
    [resolve(mobileRoot, "scripts/build-terminal-webview.mjs")],
    { cwd: mobileRoot, env, timeoutMs: 120_000 });
  const generatedHtmlAfter = sha256(await readFile(generatedHtml));
  const sourceAfterTerminal = await sourceTree(mobileRoot, sharedRoot);
  const sourceAfterTerminalWithoutGenerated = await sourceTree(mobileRoot, sharedRoot, true);
  assert.equal(sourceAfterTerminalWithoutGenerated.sha256, sourceBeforeWithoutGenerated.sha256,
    "terminal prebuild changed source outside its generated HTML output");

  const officialDistRoot = context.pathInArtifacts(OFFICIAL_DIST_NAME);
  await assertAbsent(officialDistRoot, "official export output");
  await mkdir(dirname(officialDistRoot), { recursive: true, mode: 0o700 });
  const exporter = await runOwned(context, "174-official-gateway-web-export", NODE_PATH,
    [resolve(mobileRoot, "scripts/export-gateway-web.mjs"), "--output-dir", officialDistRoot],
    { cwd: mobileRoot, env, timeoutMs: 600_000 });

  const officialManifestPath = resolve(officialDistRoot, "kcoder-mobile-web.json");
  const officialManifestBytes = await readFile(officialManifestPath);
  const officialManifestSha256 = sha256(officialManifestBytes);
  const officialManifest = JSON.parse(officialManifestBytes.toString("utf8"));
  assert.equal(officialManifest.version, 1);
  assert.equal(officialManifest.baseToken, BASE_TOKEN);
  assert.ok(Array.isArray(officialManifest.files));
  assert.equal(officialManifest.files.length, 37, "official Gateway export must expose 37 public resources");
  assert.equal(officialManifest.files.filter(file => file.path.endsWith(".map")).length, 0);
  const reuseFiles = officialManifest.files.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }));
  assert.equal(reuseFiles.filter(file => file.path === "index.html").length, 1);
  const officialFiles = await listRegularFiles(officialDistRoot);
  const expectedOfficialPaths = ["kcoder-mobile-web.json", ...reuseFiles.map(file => file.path)].sort(comparePath);
  assert.deepEqual(officialFiles.map(file => file.path).sort(comparePath), expectedOfficialPaths,
    "official deployment must contain exactly its 37 resources plus its Gateway manifest");
  for (const file of reuseFiles) {
    const actual = officialFiles.find(entry => entry.path === file.path);
    assert.deepEqual(actual, file, `official export file differs from Gateway manifest: ${file.path}`);
  }
  const bundleSha256 = hashJson(reuseFiles);
  const sourceTreeSha256 = sourceBefore.sha256;
  const indexHtmlSha256 = reuseFiles.find(file => file.path === "index.html").sha256;

  const reuseBundleRoot = context.pathInArtifacts(REUSE_BUNDLE_NAME);
  await assertAbsent(reuseBundleRoot, "reuse-only bundle directory");
  await mkdir(reuseBundleRoot, { recursive: false, mode: 0o700 });
  for (const file of reuseFiles) {
    const source = resolve(officialDistRoot, file.path);
    const destination = resolve(reuseBundleRoot, file.path);
    const relativeDestination = relative(reuseBundleRoot, destination);
    assert.ok(relativeDestination && !relativeDestination.startsWith(`..${sep}`) && !relativeDestination.startsWith(sep));
    await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    assert.equal(sha256(await readFile(destination)), file.sha256);
  }
  const reuseManifest = {
    schemaVersion: 1,
    purpose: "Reuse wrapper for the official Gateway Mobile Web export from Git 9925461ca047031f3f7f37d1f039d986c305fec3; no second Expo build",
    sourceCommit: SOURCE_COMMIT,
    sourceTreeSha256,
    bundleSha256,
    bundleFileCount: reuseFiles.length,
    indexHtmlSha256,
    directory: `artifacts/${REUSE_BUNDLE_NAME}`,
    files: reuseFiles,
  };
  const reuseManifestPath = context.pathInArtifacts(REUSE_MANIFEST_NAME);
  await writeJsonExclusive(reuseManifestPath, reuseManifest);

  const sourceAfterExport = await sourceTree(mobileRoot, sharedRoot, true);
  assert.equal(sourceAfterExport.sha256, sourceBeforeWithoutGenerated.sha256,
    "official exporter changed source outside terminal generated HTML");
  const dependencyAfter = await dependencyTree(dependencyPath);
  assert.deepEqual(dependencyAfter, dependencyBefore, "verified dependency tree changed during export");
  const sourceFreezeArtifact = context.pathInArtifacts("source-freeze-9925461c.json");
  const archiveArtifact = context.pathInArtifacts("source-9925461c.tar");
  await writeFile(sourceFreezeArtifact, freezeBytes, { flag: "wx", mode: 0o600 });
  await writeFile(archiveArtifact, archiveBytes, { flag: "wx", mode: 0o600 });

  const result = {
    source: {
      commit: SOURCE_COMMIT,
      mobileTree: EXPECTED_TREES[MOBILE_RELATIVE],
      sharedTree: EXPECTED_TREES[SHARED_RELATIVE],
      freezeManifestSha256: FREEZE_SHA256,
      gitArchiveSha256: ARCHIVE_SHA256,
      gitBlobAndModeVerification: gitVerification,
      packageLockSha256: MOBILE_LOCK_SHA256,
      sourceTreeSha256,
      terminalGeneratedHtmlSha256Before: generatedHtmlBefore,
      terminalGeneratedHtmlSha256After: generatedHtmlAfter,
      sourceUnchangedOutsideGeneratedHtml: true,
    },
    node: { path: NODE_PATH, version: process.version, sha256: nodeHash },
    dependencies: {
      sourceRoot: dependencyPath,
      sourceTreeSha256Before: dependencyBefore.sha256,
      sourceTreeSha256After: dependencyAfter.sha256,
      fileEntryCount: dependencyBefore.fileCount,
      sourceUnchanged: true,
    },
    processes: { terminalBuilderPid: terminalBuilder.pid, officialExporterPid: exporter.pid },
    officialDeployment: {
      directory: relative(context.runRoot, officialDistRoot).split(sep).join("/"),
      manifestPath: relative(context.runRoot, officialManifestPath).split(sep).join("/"),
      manifestSha256: officialManifestSha256,
      resourceCount: reuseFiles.length,
      physicalFileCount: officialFiles.length,
      bundleSha256,
      indexHtmlSha256,
    },
    reuseInput: {
      manifestPath: relative(context.runRoot, reuseManifestPath).split(sep).join("/"),
      manifestSha256: sha256(await readFile(reuseManifestPath)),
      bundleRoot: relative(context.runRoot, reuseBundleRoot).split(sep).join("/"),
      bundleSha256,
      resourceCount: reuseFiles.length,
      officialManifestRemainsSeparate: true,
    },
    exportPerformedOnce: true,
    sourceSnapshotFromGitArchive: true,
  };
  await context.writeArtifactJson("official-mobile-web-export-9925461c.json", result);
  return result;
});
