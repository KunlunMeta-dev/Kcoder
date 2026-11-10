import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, readlink, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const NODE_PATH = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const NODE_VERSION = "v22.17.0";
const NODE_SHA256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const BEFORE_COMMIT = "10feb0e049e4a3de3aef6c2ecf011e2cac55c66d";
const AFTER_COMMIT = "9925461ca047031f3f7f37d1f039d986c305fec3";
const BEFORE_LOCK_SHA256 = "848076f520f165128b601b27d96d4d32cf25e8929ee54b672f198b9a4c224e26";
const AFTER_LOCK_SHA256 = "7c47b7ad5427ac56682f19c6fb7e46cff6e442ad8f52edee283665a38cd2e68b";
const SOURCE_ROOT = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/apps/kcoder-studio/mobile/node_modules";
const EXPECTED_SOURCE_TREE_SHA256 = "bb1be282d25a7ae2d17008a895442d999813e89c1743a833a0a71d7195932f42";
const SNAPSHOT_PARENT = resolve(repoRoot, "target/private-phone-ux-validation/mobile-node-modules-common-current-20261009");
const SNAPSHOT_ROOT = resolve(SNAPSHOT_PARENT, "node_modules");
const MANIFEST_PATH = resolve(SNAPSHOT_PARENT, "snapshot-manifest.json");
const DEPENDENCY_DESTINATION = "apps/kcoder-studio/mobile/node_modules";
const TEST_ID = "mobile-dependency-snapshot-common-current-20261009";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

async function runOwned(context, label, command, args, { cwd = repoRoot, timeoutMs = 10 * 60_000 } = {}) {
  const child = context.spawnOwned(label, command, args, {
    cwd,
    env: context.isolatedEnvironment({ PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" }),
    windowsHide: true,
  });
  const stdoutChunks = [];
  let stdoutBytes = 0;
  let stdoutOverflow = false;
  child.stdout?.on("data", chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 8 * 1024 * 1024) stdoutChunks.push(Buffer.from(chunk));
    else stdoutOverflow = true;
  });
  let spawnError = null;
  child.once("error", error => { spawnError = error; });
  try {
    await waitFor(
      () => spawnError || child.exitCode !== null || child.signalCode !== null,
      timeoutMs,
      `owned ${label}`,
      100,
      context.abortSignal,
    );
    if (spawnError) throw new Error(`${label} could not start: ${spawnError.name}`);
    assert.equal(child.exitCode, 0, `${label} exited with ${child.signalCode || child.exitCode}`);
    assert.equal(stdoutOverflow, false, `${label} stdout exceeded the bounded capture`);
    return { pid: child.pid ?? null, stdout: Buffer.concat(stdoutChunks) };
  } finally {
    await context.stopOwned(label);
  }
}

async function readPinnedLock(context, label, commit, expectedSha256) {
  const output = await runOwned(context, `read-lock-${label}`, "/usr/bin/git", [
    "show", `${commit}:apps/kcoder-studio/mobile/package-lock.json`,
  ]);
  const lockBytes = output.stdout;
  assert.equal(sha256(lockBytes), expectedSha256, `${label} source package-lock changed`);
  const lock = JSON.parse(lockBytes.toString("utf8"));
  assert.equal(lock.lockfileVersion, 3, `${label} package-lock version changed`);
  return { lock, lockSha256: sha256(lockBytes) };
}

async function checkLockAgainstSnapshot(context, label, commit, expectedSha256, snapshotRoot) {
  const { lock, lockSha256 } = await readPinnedLock(context, label, commit, expectedSha256);
  let lockedPackageVersions = 0;
  let installedVersionMatches = 0;
  let optionalPlatformPackagesMissing = 0;
  let versionMismatches = 0;
  const mismatchExamples = [];
  for (const [lockPath, entry] of Object.entries(lock.packages || {})) {
    if (!lockPath.startsWith("node_modules/") || !entry || typeof entry !== "object" || typeof entry.version !== "string") continue;
    lockedPackageVersions += 1;
    const relativePackagePath = lockPath.slice("node_modules/".length);
    const packageJson = resolve(snapshotRoot, relativePackagePath, "package.json");
    let installed;
    try {
      installed = JSON.parse(await readFile(packageJson, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" || entry.optional !== true) {
        throw new Error(`${label} lock entry is missing or unreadable in common snapshot: ${lockPath}`);
      }
      optionalPlatformPackagesMissing += 1;
      continue;
    }
    if (installed.version === entry.version) {
      installedVersionMatches += 1;
    } else {
      versionMismatches += 1;
      if (mismatchExamples.length < 12) mismatchExamples.push({ path: lockPath, locked: entry.version, installed: installed.version ?? null });
    }
  }
  assert.equal(versionMismatches, 0, `${label} lock has installed package version mismatches`);
  return {
    commit,
    packageLockSha256: lockSha256,
    lockfileVersion: lock.lockfileVersion,
    lockedPackageVersions,
    installedVersionMatches,
    optionalPlatformPackagesMissing,
    versionMismatches,
    mismatchExamples,
    packages: lock.packages,
  };
}

async function collectTree(root) {
  const canonicalRoot = await realpath(root);
  const rootInfo = await lstat(canonicalRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "dependency root must be a canonical directory");
  assert.equal(canonicalRoot, resolve(root), "dependency root path changed through a symlink");
  const entries = [];
  let regularFileCount = 0;
  let symlinkCount = 0;

  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const path = relative(canonicalRoot, absolute).split(sep).join("/");
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        const resolvedTarget = await realpath(absolute);
        assert.ok(!target.startsWith("/"), `dependency symlink must be relocatable: ${path}`);
        assert.ok(
          resolvedTarget === canonicalRoot || resolvedTarget.startsWith(`${canonicalRoot}${sep}`),
          `dependency symlink escapes its root: ${path}`,
        );
        entries.push({ path, type: "symlink", target });
        symlinkCount += 1;
      } else if (info.isDirectory()) {
        await visit(absolute);
      } else if (info.isFile()) {
        const bytes = await readFile(absolute);
        entries.push({ path, size: bytes.length, sha256: sha256(bytes) });
        regularFileCount += 1;
      } else {
        throw new Error(`unsupported dependency filesystem entry: ${path}`);
      }
    }
  }

  await visit(canonicalRoot);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const rootSha256 = hashJson(entries);
  return {
    root: canonicalRoot,
    entries,
    rootSha256,
    treeSha256: hashJson([{ name: "mobile-dependencies", destination: DEPENDENCY_DESTINATION, sha256: rootSha256 }]),
    fileCount: entries.length,
    regularFileCount,
    symlinkCount,
  };
}

function diffEntries(before, after) {
  const left = new Map(before.map(entry => [entry.path, JSON.stringify(entry)]));
  const right = new Map(after.map(entry => [entry.path, JSON.stringify(entry)]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a.localeCompare(b));
  return paths.flatMap(path => {
    if (left.get(path) === right.get(path)) return [];
    return [{
      path,
      before: left.has(path) ? JSON.parse(left.get(path)) : null,
      after: right.has(path) ? JSON.parse(right.get(path)) : null,
    }];
  });
}

async function makeReadOnly(root) {
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const path = resolve(directory, child.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(path);
      const mode = info.mode & 0o777;
      await chmod(path, info.isDirectory() ? mode & ~0o222 : mode & ~0o222);
    }
  }
  await visit(root);
  const rootInfo = await lstat(root);
  await chmod(root, rootInfo.mode & 0o777 & ~0o222);
}

await runE2E(import.meta.url, {
  testId: TEST_ID,
  kind: "model-independent",
  modelPolicy: "none",
  summary: "Freeze the currently installed Mobile dependency tree as a new common diagnostic input; not the historical 46b02 tree",
  totalTimeoutMs: 20 * 60_000,
  cleanupTimeoutMs: 30_000,
  retainSuccessLogs: true,
}, async context => {
  assert.equal(process.execPath, NODE_PATH, "run using pinned Node 22.17 executable");
  assert.equal(process.version, NODE_VERSION, "Node version changed");
  assert.equal(sha256(await readFile(process.execPath)), NODE_SHA256, "Node binary changed");
  assert.equal(await realpath(repoRoot), repoRoot, "F checkout must be canonical");
  const sourceBefore = await collectTree(SOURCE_ROOT);
  await context.writeArtifactJson("dependency-snapshot-source-before.json", {
    classification: "candidate current source inventory; not the unavailable historical 46b02 per-file inventory",
    root: sourceBefore.root,
    sourceRootSha256: sourceBefore.rootSha256,
    sourceTreeSha256: sourceBefore.treeSha256,
    fileCount: sourceBefore.fileCount,
    regularFileCount: sourceBefore.regularFileCount,
    symlinkCount: sourceBefore.symlinkCount,
    entries: sourceBefore.entries,
  });
  assert.equal(sourceBefore.treeSha256, EXPECTED_SOURCE_TREE_SHA256, "current installed dependency input changed since the latest measured candidate");

  await mkdir(SNAPSHOT_PARENT, { recursive: false, mode: 0o700 });
  const parentInfo = await lstat(SNAPSHOT_PARENT);
  const parentIdentity = { dev: parentInfo.dev, ino: parentInfo.ino, uid: parentInfo.uid };
  let snapshotComplete = false;
  context.addCleanup("remove incomplete owned dependency snapshot", async () => {
    if (snapshotComplete) return;
    const current = await lstat(SNAPSHOT_PARENT).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!current) return;
    assert.ok(current.isDirectory() && !current.isSymbolicLink(), "incomplete snapshot parent changed type");
    assert.equal(current.dev, parentIdentity.dev, "incomplete snapshot parent device changed");
    assert.equal(current.ino, parentIdentity.ino, "incomplete snapshot parent inode changed");
    assert.equal(current.uid, parentIdentity.uid, "incomplete snapshot parent owner changed");
    await rm(SNAPSHOT_PARENT, { recursive: true, force: false });
  });

  await mkdir(SNAPSHOT_ROOT, { recursive: false, mode: 0o700 });
  const copy = await runOwned(context, "copy-current-mobile-dependencies", "/usr/bin/cp", [
    "-a", "--reflink=auto", `${sourceBefore.root}/.`, `${SNAPSHOT_ROOT}/`,
  ]);
  const snapshotBeforeReadOnly = await collectTree(SNAPSHOT_ROOT);
  const snapshotChangedPaths = diffEntries(sourceBefore.entries, snapshotBeforeReadOnly.entries);
  await context.writeArtifactJson("dependency-snapshot-copy-comparison.json", {
    sourceTreeSha256: sourceBefore.treeSha256,
    snapshotTreeSha256: snapshotBeforeReadOnly.treeSha256,
    sourceEntryCount: sourceBefore.entries.length,
    snapshotEntryCount: snapshotBeforeReadOnly.entries.length,
    changedEntryCount: snapshotChangedPaths.length,
    changedEntries: snapshotChangedPaths,
  });
  assert.deepEqual(snapshotChangedPaths, [], "copied dependency snapshot differs from source tree");
  const sourceAfterCopy = await collectTree(SOURCE_ROOT);
  const sourceChangedPaths = diffEntries(sourceBefore.entries, sourceAfterCopy.entries);
  await context.writeArtifactJson("dependency-snapshot-source-after-comparison.json", {
    sourceBeforeTreeSha256: sourceBefore.treeSha256,
    sourceAfterTreeSha256: sourceAfterCopy.treeSha256,
    sourceBeforeEntryCount: sourceBefore.entries.length,
    sourceAfterEntryCount: sourceAfterCopy.entries.length,
    changedEntryCount: sourceChangedPaths.length,
    changedEntries: sourceChangedPaths,
  });
  assert.deepEqual(sourceChangedPaths, [], "source dependencies changed while snapshot was copied");

  const lockBefore = await checkLockAgainstSnapshot(context, "before-10feb", BEFORE_COMMIT, BEFORE_LOCK_SHA256, SNAPSHOT_ROOT);
  const lockAfter = await checkLockAgainstSnapshot(context, "after-992", AFTER_COMMIT, AFTER_LOCK_SHA256, SNAPSHOT_ROOT);
  const afterOnlyPackageEntries = Object.entries(lockAfter.packages)
    .filter(([path, entry]) => {
      const previous = lockBefore.packages[path];
      return typeof entry?.version === "string" && (!previous || previous.version !== entry.version);
    })
    .map(([path, entry]) => [path, entry.version]);
  const beforeOnlyPackageEntries = Object.entries(lockBefore.packages)
    .filter(([path, entry]) => {
      const next = lockAfter.packages[path];
      return typeof entry?.version === "string" && (!next || next.version !== entry.version);
    })
    .map(([path, entry]) => [path, entry.version]);
  assert.deepEqual(afterOnlyPackageEntries, [
    ["node_modules/expo-localization", "17.0.9"],
    ["node_modules/expo-system-ui", "6.0.9"],
    ["node_modules/html-parse-stringify", "4.0.1"],
    ["node_modules/i18next", "26.4.2"],
    ["node_modules/react-i18next", "17.0.16"],
    ["node_modules/rtl-detect", "1.1.2"],
  ], "lockfile delta changed from the reviewed six after-only package entries");
  assert.deepEqual(beforeOnlyPackageEntries, [], "before lock unexpectedly contains packages absent from after lock");
  assert.equal(lockBefore.lockedPackageVersions, 941);
  assert.equal(lockBefore.installedVersionMatches, 885);
  assert.equal(lockBefore.optionalPlatformPackagesMissing, 56);
  assert.equal(lockAfter.lockedPackageVersions, 947);
  assert.equal(lockAfter.installedVersionMatches, 891);
  assert.equal(lockAfter.optionalPlatformPackagesMissing, 56);

  await makeReadOnly(SNAPSHOT_ROOT);
  const snapshotAfterReadOnly = await collectTree(SNAPSHOT_ROOT);
  assert.equal(snapshotAfterReadOnly.treeSha256, sourceBefore.treeSha256, "read-only snapshot content changed");
  assert.ok(snapshotAfterReadOnly.entries.length > 50_000, "unexpectedly small dependency snapshot");

  const manifest = {
    schemaVersion: 1,
    status: "complete",
    snapshotId: "mobile-dependency-snapshot-common-current-20261009",
    classification: "new-common-current-dependency-snapshot; distinct from historical 46b02fc5 snapshot",
    snapshotRoot: SNAPSHOT_ROOT,
    manifestPath: MANIFEST_PATH,
    sourceRoot: sourceBefore.root,
    sourceTreeSha256Before: sourceBefore.treeSha256,
    sourceTreeSha256After: sourceAfterCopy.treeSha256,
    snapshotTreeSha256: snapshotAfterReadOnly.treeSha256,
    sourceRootSha256: sourceBefore.rootSha256,
    snapshotRootSha256: snapshotAfterReadOnly.rootSha256,
    fileCount: snapshotAfterReadOnly.fileCount,
    regularFileCount: snapshotAfterReadOnly.regularFileCount,
    symlinkCount: snapshotAfterReadOnly.symlinkCount,
    allSymlinksRelativeAndConfined: true,
    permissions: "snapshot file and directory write bits removed; tree digest excludes mode and hashes paths/content/link targets",
    copyProcessPid: copy.pid,
    previousFailedExpectedTreeSha256: "46b02fc5ac823118f6eb2c034ea3f1d9cbbf79b71041fc2fa848f79a9abca1c6",
    lockfiles: {
      before10feb: {
        commit: lockBefore.commit,
        packageLockSha256: lockBefore.packageLockSha256,
        lockfileVersion: lockBefore.lockfileVersion,
        lockedPackageVersions: lockBefore.lockedPackageVersions,
        installedVersionMatches: lockBefore.installedVersionMatches,
        optionalPlatformPackagesMissing: lockBefore.optionalPlatformPackagesMissing,
        versionMismatches: lockBefore.versionMismatches,
      },
      after992: {
        commit: lockAfter.commit,
        packageLockSha256: lockAfter.packageLockSha256,
        lockfileVersion: lockAfter.lockfileVersion,
        lockedPackageVersions: lockAfter.lockedPackageVersions,
        installedVersionMatches: lockAfter.installedVersionMatches,
        optionalPlatformPackagesMissing: lockAfter.optionalPlatformPackagesMissing,
        versionMismatches: lockAfter.versionMismatches,
      },
      comparison: {
        lockfileVersion: 3,
        before: { lockedPackageVersions: lockBefore.lockedPackageVersions, installedVersionMatches: lockBefore.installedVersionMatches, optionalMissing: lockBefore.optionalPlatformPackagesMissing, versionMismatches: lockBefore.versionMismatches },
        after: { lockedPackageVersions: lockAfter.lockedPackageVersions, installedVersionMatches: lockAfter.installedVersionMatches, optionalMissing: lockAfter.optionalPlatformPackagesMissing, versionMismatches: lockAfter.versionMismatches },
        beforeOnlyPackageEntries,
        afterOnlyPackageEntries,
        method: "Every lockfile package entry with a version was compared with snapshot package.json; missing entries were accepted only when lock entry optional=true; both lock files had 0 installed version mismatches.",
      },
    },
    entries: snapshotAfterReadOnly.entries,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(MANIFEST_PATH, manifestBytes, { flag: "wx", mode: 0o600 });
  const manifestSha256 = sha256(manifestBytes);
  await context.writeArtifactJson("dependency-snapshot-complete.json", {
    snapshotRoot: SNAPSHOT_ROOT,
    manifestPath: MANIFEST_PATH,
    manifestSha256,
    snapshotTreeSha256: snapshotAfterReadOnly.treeSha256,
    fileCount: snapshotAfterReadOnly.fileCount,
    regularFileCount: snapshotAfterReadOnly.regularFileCount,
    symlinkCount: snapshotAfterReadOnly.symlinkCount,
    lockCompatibility: manifest.lockfiles.comparison,
  });
  snapshotComplete = true;
  return { status: "immutable-common-current-dependency-snapshot", ...JSON.parse(JSON.stringify({
    snapshotRoot: SNAPSHOT_ROOT,
    manifestPath: MANIFEST_PATH,
    manifestSha256,
    snapshotTreeSha256: snapshotAfterReadOnly.treeSha256,
    fileCount: snapshotAfterReadOnly.fileCount,
    regularFileCount: snapshotAfterReadOnly.regularFileCount,
    symlinkCount: snapshotAfterReadOnly.symlinkCount,
  })) };
});
