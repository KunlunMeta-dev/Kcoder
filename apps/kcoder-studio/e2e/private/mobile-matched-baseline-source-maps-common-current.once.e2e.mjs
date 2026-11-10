import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { copyFrozenMobileWeb } from "../harness/frozen-copy.mjs";
import { exportMobileWeb } from "../harness/mobile-web-export.mjs";
import { verifySourceMapBundleEvidence } from "../harness/render-profile-attribution-contract.mjs";
import { appRoot, repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const MATCHED_BASELINE_ID = "common-current-dependencies-before10feb-after992-source-maps-diagnostic";
const TEST_ID = "mobile-matched-before-10feb-9925461c-source-maps-common-current-20261009";
const NODE_PATH = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const NODE_VERSION = "v22.17.0";
const NODE_SHA256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const BEFORE_COMMIT = "10feb0e049e4a3de3aef6c2ecf011e2cac55c66d";
const COMPARISON_COMMIT = "9925461ca047031f3f7f37d1f039d986c305fec3";
const MOBILE_RELATIVE = "apps/kcoder-studio/mobile";
const SHARED_RELATIVE = "apps/kcoder-studio/shared";
const EXPECTED_TREES = {
  [BEFORE_COMMIT]: {
    mobile: "25146d587811c422695e597f1699c587312bb263",
    shared: "8270e871236a15579a2302e4b46f35642837b1be",
    packageLockSha256: "848076f520f165128b601b27d96d4d32cf25e8929ee54b672f198b9a4c224e26",
    appConfigSha256: "4a397b289a5f198b97e8a4a1de269ac40b15173e3e95a0c1241a61311267cd13",
  },
  [COMPARISON_COMMIT]: {
    mobile: "80d41cf2979f7dab00973c6dd6e45e173734d112",
    shared: "8270e871236a15579a2302e4b46f35642837b1be",
    packageLockSha256: "7c47b7ad5427ac56682f19c6fb7e46cff6e442ad8f52edee283665a38cd2e68b",
  },
};
const EXPECTED_DEPENDENCY_SOURCE_SHA256 = "bb1be282d25a7ae2d17008a895442d999813e89c1743a833a0a71d7195932f42";
const DEPENDENCY_MANIFEST_PATH = resolve(
  repoRoot,
  "target/private-phone-ux-validation/mobile-node-modules-common-current-20261009/snapshot-manifest.json",
);
const DEPENDENCY_MANIFEST_SHA256 = "321aa0e4a8621ac1022b4abaeeab76bbf28008b7a862d56c03820275e82c6ede";
const HISTORICAL_AFTER349_DEPENDENCY_SOURCE_SHA256 = "7f5cc5b56527cb4a441bc6fa091c7e2cb090c91aaa95298eca487cea8550284d";
const HISTORICAL_AFTER349_DEPENDENCY_OWNED_SHA256 = "1222bea9cd9c1cb296e0516c6973c714b7ca3c9fb837d1d0c0698b3f797444c7";
const HISTORICAL_AFTER349_DIST_MANIFEST_SHA256 = "5053ac22d3476f7f17513a3c76a71b8993f3752e47bd060b8bead5c07c830752";
const DEPENDENCY_ROOT = resolve(
  repoRoot,
  "target/private-phone-ux-validation/mobile-node-modules-common-current-20261009/node_modules",
);
const BASE_TOKEN = "/__kcoder_mobile_mount_v1__";
const MOUNT_OVERLAY = [
  "    experiments: {",
  "      ...appJson.expo.experiments,",
  '      ...(process.env.KCODER_STUDIO_MOBILE_WEB_DEPLOY === "1"',
  `        ? { baseUrl: "${BASE_TOKEN}" } : {}),`,
  "    },",
  "",
].join("\n");
const DEPENDENCY_DESTINATION = "apps/kcoder-studio/mobile/node_modules";
const OUTPUT_PARENT = resolve(repoRoot, "target/private-phone-ux-validation/common-current-dependencies-before10feb-after992-source-maps-20261009");
const ALLOWED_MODES = new Set(["--preflight-only", "--export"]);
const MODE = process.argv.slice(2);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function ownedProcess(context, label, command, args, { cwd = repoRoot, timeoutMs = 30_000 } = {}) {
  const env = context.isolatedEnvironment({
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
  const child = context.spawnOwned(label, command, args, { cwd, env, windowsHide: true });
  const stdout = [];
  let stdoutBytes = 0;
  let overflow = false;
  let spawnError = null;
  child.stdout?.on("data", chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 8 * 1024 * 1024) stdout.push(Buffer.from(chunk));
    else overflow = true;
  });
  child.once("error", error => { spawnError = error; });
  try {
    await waitFor(
      () => spawnError || child.exitCode !== null || child.signalCode !== null,
      timeoutMs,
      `owned ${command} ${label}`,
      50,
      context.abortSignal,
    );
    if (spawnError) throw new Error(`${label} failed to start: ${spawnError.name}`);
    assert.equal(child.exitCode, 0, `${label} exited with ${child.signalCode || child.exitCode}`);
    assert.equal(overflow, false, `${label} stdout exceeded the bounded capture`);
    return { stdout: Buffer.concat(stdout), pid: child.pid ?? null };
  } finally {
    await context.stopOwned(label);
  }
}

async function gitText(context, label, args) {
  const result = await ownedProcess(context, label, "git", args);
  return result.stdout.toString("utf8").trim();
}

function parseLsTree(output, expectedRoot) {
  const records = output.toString("utf8").split("\0").filter(Boolean);
  const entries = records.map(record => {
    const tab = record.indexOf("\t");
    assert.ok(tab > 0, "git ls-tree record is malformed");
    const [mode, type, objectId] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    assert.ok(path === expectedRoot || path.startsWith(`${expectedRoot}/`), "Git source path escaped its declared root");
    assert.ok(mode === "100644" || mode === "100755", `unsupported Git source mode ${mode}`);
    assert.equal(type, "blob", "Git source tree cannot contain submodules or non-blob entries");
    assert.match(objectId, /^[a-f0-9]{40}$/, "Git source blob identity is invalid");
    return { mode, objectId, path };
  });
  entries.sort((left, right) => codeUnitCompare(left.path, right.path));
  return entries;
}

async function gitInventory(context, commit, root, label) {
  const output = await ownedProcess(context, `tree-${label}`, "git", [
    "ls-tree", "-r", "-z", "--full-tree", commit, "--", root,
  ]);
  const entries = parseLsTree(output.stdout, root);
  return {
    entries,
    fileCount: entries.length,
    inventorySha256: sha256(output.stdout),
  };
}

async function collectRegularFiles(root) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => codeUnitCompare(left.name, right.name));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      const info = await lstat(absolute);
      assert.equal(info.isSymbolicLink(), false, `source archive contains a symlink: ${relativePath}`);
      if (info.isDirectory()) {
        await visit(absolute);
      } else {
        assert.ok(info.isFile(), `source archive contains a special file: ${relativePath}`);
        const bytes = await readFile(absolute);
        entries.push({ path: relativePath, size: bytes.length, bytes, mode: info.mode });
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => codeUnitCompare(left.path, right.path));
  return entries;
}

function gitBlobSha1(bytes) {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}

async function verifyMaterializedTree(stageRoot, inventory) {
  const actual = await collectRegularFiles(stageRoot);
  assert.deepEqual(actual.map(entry => entry.path), inventory.map(entry => entry.path), "Git archive file list differs from pinned tree");
  for (let index = 0; index < inventory.length; index += 1) {
    const expected = inventory[index];
    const file = actual[index];
    assert.equal(gitBlobSha1(file.bytes), expected.objectId, `Git archive blob changed: ${expected.path}`);
    assert.equal(Boolean(file.mode & 0o111), expected.mode === "100755", `Git archive executable mode changed: ${expected.path}`);
  }
  return {
    fileCount: actual.length,
    extractedContentSha256: hashJson(actual.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: sha256(bytes) }))),
  };
}

async function materializeSnapshot(context, commit, label, expected) {
  const commitId = await gitText(context, `commit-${label}`, ["rev-parse", `${commit}^{commit}`]);
  assert.equal(commitId, commit, `${label} Git commit pin changed`);
  const mobileTree = await gitText(context, `mobile-tree-${label}`, ["rev-parse", `${commit}:${MOBILE_RELATIVE}`]);
  const sharedTree = await gitText(context, `shared-tree-${label}`, ["rev-parse", `${commit}:${SHARED_RELATIVE}`]);
  assert.equal(mobileTree, expected.mobile, `${label} Mobile Git tree changed`);
  assert.equal(sharedTree, expected.shared, `${label} Shared Git tree changed`);
  const mobileInventory = await gitInventory(context, commit, MOBILE_RELATIVE, `${label}-mobile`);
  const sharedInventory = await gitInventory(context, commit, SHARED_RELATIVE, `${label}-shared`);
  const inventory = [...mobileInventory.entries, ...sharedInventory.entries]
    .sort((left, right) => codeUnitCompare(left.path, right.path));
  const inventorySha256 = hashJson(inventory.map(({ mode, objectId, path }) => ({ mode, objectId, path })));
  const stageRoot = context.pathInState(`source-${label}`);
  await mkdir(stageRoot, { recursive: false, mode: 0o700 });
  const archivePath = context.pathInState(`source-${label}.tar`);
  await ownedProcess(context, `archive-${label}`, "git", [
    "archive", "--format=tar", `--output=${archivePath}`, commit, MOBILE_RELATIVE, SHARED_RELATIVE,
  ]);
  await ownedProcess(context, `extract-${label}`, "tar", [
    "--extract", "--file", archivePath, "--directory", stageRoot, "--no-same-owner",
  ]);
  const mobileRoot = resolve(stageRoot, MOBILE_RELATIVE);
  const sharedRoot = resolve(stageRoot, SHARED_RELATIVE);
  const materialized = await verifyMaterializedTree(resolve(stageRoot, "apps/kcoder-studio"), inventory.map(entry => ({
    ...entry,
    path: entry.path.slice("apps/kcoder-studio/".length),
  })));
  const lock = await readFile(resolve(mobileRoot, "package-lock.json"));
  assert.equal(sha256(lock), expected.packageLockSha256, `${label} package-lock Git input changed`);
  let overlay = null;
  if (label === "before-10feb") {
    const configPath = resolve(mobileRoot, "app.config.ts");
    const original = await readFile(configPath);
    assert.equal(sha256(original), expected.appConfigSha256, "10feb app.config input changed");
    const text = original.toString("utf8");
    const anchor = "    ...appJson.expo,\n";
    assert.equal(text.split(anchor).length - 1, 1, "mount overlay anchor must be unique");
    const updated = Buffer.from(text.replace(anchor, `${anchor}${MOUNT_OVERLAY}`));
    await writeFile(configPath, updated);
    overlay = {
      purpose: "build-only deploy mount parity",
      path: "apps/kcoder-studio/mobile/app.config.ts",
      baseFileSha256: sha256(original),
      insertedBlockSha256: sha256(Buffer.from(MOUNT_OVERLAY)),
      updatedFileSha256: sha256(updated),
      baseToken: BASE_TOKEN,
    };
  } else {
    const config = await readFile(resolve(mobileRoot, "app.config.ts"), "utf8");
    assert.ok(config.includes(`baseUrl: "${BASE_TOKEN}"`), "9925461c source lacks the pinned deploy mount config");
  }
  return {
    label,
    commit: commitId,
    gitTrees: { mobile: mobileTree, shared: sharedTree },
    sourceInventorySha256: inventorySha256,
    sourceFileCount: inventory.length,
    sourceRoots: { mobile: mobileRoot, shared: sharedRoot },
    packageLockSha256: sha256(lock),
    materialized,
    mountOverlay: overlay,
  };
}

async function collectDependencyTree(root) {
  const resolvedRoot = await realpath(root);
  const rootInfo = await lstat(resolvedRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "dependency root must be a canonical directory");
  assert.equal(resolvedRoot, resolve(root), "dependency root path changed through a symlink");
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const path = relative(resolvedRoot, absolute).split(sep).join("/");
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const target = await realpath(absolute);
        assert.ok(target === resolvedRoot || target.startsWith(`${resolvedRoot}${sep}`), `dependency symlink escapes root: ${path}`);
        entries.push({ path, type: "symlink", target: await readlink(absolute) });
      } else if (info.isDirectory()) {
        await visit(absolute);
      } else if (info.isFile()) {
        const bytes = await readFile(absolute);
        entries.push({ path, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(resolvedRoot);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const rootSha256 = hashJson(entries);
  return {
    root: resolvedRoot,
    rootSha256,
    treeSha256: hashJson([{
      name: "mobile-dependencies",
      destination: DEPENDENCY_DESTINATION,
      sha256: rootSha256,
    }]),
    fileCount: entries.length,
  };
}

async function verifyInputs(context) {
  assert.equal(process.execPath, NODE_PATH, "run using the pinned Node 22.17 executable");
  assert.equal(process.version, NODE_VERSION, "Node version changed");
  assert.equal(sha256(await readFile(process.execPath)), NODE_SHA256, "Node binary changed");
  const repo = await realpath(repoRoot);
  assert.equal(repo, repoRoot, "F checkout must be canonical");
  const gitRoot = await gitText(context, "git-root", ["rev-parse", "--show-toplevel"]);
  assert.equal(await realpath(gitRoot), repoRoot, "runner is executing outside the fixed F checkout");
  const format = await gitText(context, "git-object-format", ["rev-parse", "--show-object-format"]);
  assert.equal(format, "sha1", "Git object format changed; blob verification is not valid");

  const dependencyManifestBytes = await readFile(DEPENDENCY_MANIFEST_PATH);
  assert.equal(sha256(dependencyManifestBytes), DEPENDENCY_MANIFEST_SHA256, "common-current dependency snapshot manifest changed");
  const dependencyManifest = JSON.parse(dependencyManifestBytes.toString("utf8"));
  assert.equal(dependencyManifest.status, "complete");
  assert.equal(dependencyManifest.snapshotRoot, DEPENDENCY_ROOT);
  assert.equal(dependencyManifest.snapshotTreeSha256, EXPECTED_DEPENDENCY_SOURCE_SHA256);
  assert.equal(dependencyManifest.fileCount, 52_524);
  assert.equal(dependencyManifest.allSymlinksRelativeAndConfined, true);
  const dependency = await collectDependencyTree(DEPENDENCY_ROOT);
  assert.equal(dependency.root, DEPENDENCY_ROOT, "dependency snapshot must use the exact canonical frozen root");
  assert.equal(dependency.treeSha256, EXPECTED_DEPENDENCY_SOURCE_SHA256, "common-current immutable dependency snapshot changed");
  assert.equal(dependency.fileCount, dependencyManifest.fileCount, "common-current dependency snapshot entry count changed");
  assert.ok(Number.isSafeInteger(dependency.fileCount) && dependency.fileCount > 0, "dependency tree must contain a bounded, countable file set");
  await lstat(resolve(dependency.root, "expo/package.json"));

  const snapshots = [];
  for (const [label, commit] of [["before-10feb", BEFORE_COMMIT], ["comparison-9925461c", COMPARISON_COMMIT]]) {
    snapshots.push(await materializeSnapshot(context, commit, label, EXPECTED_TREES[commit]));
  }
  return {
    node: {
      path: process.execPath,
      version: process.version,
      sha256: NODE_SHA256,
      runtimeLocale: {
        collator: new Intl.Collator().resolvedOptions(),
        environment: {
          LANG: process.env.LANG ?? null,
          LC_ALL: process.env.LC_ALL ?? null,
          LC_COLLATE: process.env.LC_COLLATE ?? null,
        },
      },
    },
    repoRoot,
    mode: MODE[0],
    matchedBaselineId: MATCHED_BASELINE_ID,
    sources: snapshots,
    dependencies: {
      root: dependency.root,
      sourceTreeSha256: dependency.treeSha256,
      fileCount: dependency.fileCount,
      snapshotManifestPath: DEPENDENCY_MANIFEST_PATH,
      snapshotManifestSha256: DEPENDENCY_MANIFEST_SHA256,
      snapshotId: dependencyManifest.snapshotId,
      snapshotClassification: dependencyManifest.classification,
      historicalAfter349Reference: {
        dependencySourceTreeSha256: HISTORICAL_AFTER349_DEPENDENCY_SOURCE_SHA256,
        dependencyOwnedTreeSha256: HISTORICAL_AFTER349_DEPENDENCY_OWNED_SHA256,
        officialDistManifestSha256: HISTORICAL_AFTER349_DIST_MANIFEST_SHA256,
        comparableToThisBaseline: false,
      },
    },
    buildScope: "Mobile/Shared Expo web artifacts only; no Gateway runtime is built or exercised",
    mountToken: BASE_TOKEN,
  };
}

async function assertMountedBundle(exported, label) {
  const manifest = JSON.parse(await readFile(exported.bundleManifestPath, "utf8"));
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.deployMount, true);
  assert.ok(exported.bundleFileCount > 37, `${label} map-enabled export should contain the standard bundle plus maps`);
  assert.equal(manifest.bundleFileCount, exported.bundleFileCount, `${label} manifest file count differs from the returned bundle`);
  verifySourceMapBundleEvidence(manifest.sourceMapEvidence, manifest);
  assert.equal(manifest.dependencyProvenance.sourceTreeSha256Before, EXPECTED_DEPENDENCY_SOURCE_SHA256);
  assert.equal(manifest.dependencyProvenance.sourceTreeSha256After, EXPECTED_DEPENDENCY_SOURCE_SHA256);
  assert.equal(manifest.dependencyProvenance.sourceUnchanged, true);
  assert.match(manifest.dependencyProvenance.copiedTreeSha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(manifest.dependencyProvenance.copiedFileCount) && manifest.dependencyProvenance.copiedFileCount > 0);
  assert.equal(manifest.dependencyProvenance.copiedSymlinks, false);
  let containsMountToken = false;
  for (const entry of exported.bundleFiles) {
    if (!/\.(?:js|css|json|html|svg|txt|xml|webmanifest)$/i.test(entry.path)) continue;
    const bytes = await readFile(resolve(exported.path, entry.path));
    if (bytes.includes(Buffer.from(BASE_TOKEN))) containsMountToken = true;
  }
  assert.equal(containsMountToken, true, `${label} bundle has no deployment base token`);
  return manifest;
}

async function writeExclusiveJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

assert.equal(MODE.length, 1, "usage: mobile-matched-baseline-export.once.mjs --preflight-only | --export");
assert.ok(ALLOWED_MODES.has(MODE[0]), "unknown mode; no export is run unless --export is explicit");

await runE2E(import.meta.url, {
  testId: TEST_ID,
  kind: "model-independent",
  modelPolicy: "none",
  summary: "Aggregate 10feb-to-992 source-tree comparison using one immutable common-current dependency snapshot; distinct from unavailable historical 46b02 and not comparable with older after349 provenance",
  retainSuccessLogs: true,
}, async context => {
  const inputs = await verifyInputs(context);
  await context.writeArtifactJson("matched-baseline-inputs.json", inputs);
  if (MODE[0] === "--preflight-only") {
    return { status: "preflight-only", exportStarted: false, inputs };
  }

  const persistentRoot = resolve(OUTPUT_PARENT, `run-${context.seed}`);
  await mkdir(OUTPUT_PARENT, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(OUTPUT_PARENT), OUTPUT_PARENT, "persistent evidence parent must be canonical");
  try {
    await lstat(persistentRoot);
    assert.fail("matched export destination already exists; refusing overwrite");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(persistentRoot, { recursive: false, mode: 0o700 });

  const exports = [];
  for (const source of inputs.sources) {
    const exported = await exportMobileWeb(context, {
      mobileRoot: source.sourceRoots.mobile,
      sourceRoots: [
        { name: "mobile", path: source.sourceRoots.mobile, destination: MOBILE_RELATIVE },
        { name: "studio-shared", path: source.sourceRoots.shared, destination: SHARED_RELATIVE },
      ],
      dependencyRoot: inputs.dependencies.root,
      label: source.label,
      outputName: `bundle-${source.label}`,
      stateNamespace: source.label,
      sourceMaps: true,
      deployMount: true,
    });
    const exportManifest = await assertMountedBundle(exported, source.label);
    const sourceOutput = resolve(persistentRoot, source.label);
    await mkdir(sourceOutput, { recursive: false, mode: 0o700 });
    const destination = resolve(persistentRoot, source.label, "bundle");
    const copy = await copyFrozenMobileWeb({
      sourceRoot: exported.path,
      destination,
      expectedBundleSha256: exported.bundleSha256,
      manifestPath: exported.bundleManifestPath,
      expectedSourceTreeSha256: exported.sourceTreeSha256,
      expectedDependencySourceTreeSha256: EXPECTED_DEPENDENCY_SOURCE_SHA256,
    });
    assert.equal(copy.dependencySourceTreeSha256, EXPECTED_DEPENDENCY_SOURCE_SHA256);
    assert.equal(copy.dependencyOwnedTreeSha256, exportManifest.dependencyProvenance.copiedTreeSha256);
    const exportManifestDestination = resolve(persistentRoot, source.label, "export-manifest.json");
    await writeFile(exportManifestDestination, await readFile(exported.bundleManifestPath), { flag: "wx", mode: 0o600 });
    exports.push({
      label: source.label,
      gitCommit: source.commit,
      gitTrees: source.gitTrees,
      sourceInventorySha256: source.sourceInventorySha256,
      mountOverlay: source.mountOverlay,
      buildSourceTreeSha256: exported.sourceTreeSha256,
      dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
      dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
      dependencyOwnedFileCount: exportManifest.dependencyProvenance.copiedFileCount,
      bundleSha256: exported.bundleSha256,
      bundleFileCount: exported.bundleFileCount,
      sourceMapEvidence: exportManifest.sourceMapEvidence,
      indexHtmlSha256: exported.indexHtmlSha256,
      manifestPath: exportManifestDestination,
      copy,
      deployMount: exportManifest.deployMount,
    });
  }

  assert.equal(exports.length, 2, "matched baseline must contain exactly the before and comparison source exports");
  assert.equal(exports[0].dependencySourceTreeSha256, EXPECTED_DEPENDENCY_SOURCE_SHA256);
  assert.equal(exports[1].dependencySourceTreeSha256, EXPECTED_DEPENDENCY_SOURCE_SHA256);
  assert.equal(exports[0].dependencyOwnedTreeSha256, exports[1].dependencyOwnedTreeSha256, "before and comparison exports used different owned dependency copies");
  assert.equal(exports[0].dependencyOwnedFileCount, exports[1].dependencyOwnedFileCount, "before and comparison owned dependency copies have different file counts");

  const provenance = {
    schemaVersion: 1,
    status: "matched-export-complete",
    matchedBaselineId: MATCHED_BASELINE_ID,
    performanceComparison: {
      sourceComparison: "aggregate-source-tree-10feb-to-992",
      sourceMaps: true,
      profileInputClass: "matched map-enabled diagnostic exports; distinct build artifacts from the official 992 37-file bundle",
      singleOptimizationAttribution: false,
      dependencyResolutionPolicy: "Both Git source trees are exported against the same pinned dependency tree. Each package-lock is hashed as a source input but is not used to install or resolve dependencies for this comparison.",
      comparableToHistoricalAfter349Dist: false,
      reason: "The historical 46b02 per-file dependency inventory is unavailable. This diagnostic pair uses a newly created immutable common-current snapshot, verified against both frozen lockfiles; historical after349 used a different dependency source-tree digest.",
      historicalAfter349DependencySourceTreeSha256: HISTORICAL_AFTER349_DEPENDENCY_SOURCE_SHA256,
      historicalAfter349DistManifestSha256: HISTORICAL_AFTER349_DIST_MANIFEST_SHA256,
    },
    runRoot: context.runRoot,
    node: inputs.node,
    sources: inputs.sources.map(({ label, commit, gitTrees, sourceInventorySha256, sourceFileCount, packageLockSha256, mountOverlay }) => ({
      label, commit, gitTrees, sourceInventorySha256, sourceFileCount, packageLockSha256, mountOverlay,
    })),
    dependencies: inputs.dependencies,
    exports,
  };
  await writeExclusiveJson(resolve(persistentRoot, "matched-export-provenance.json"), provenance);
  await context.writeArtifactJson("matched-export-complete.json", {
    persistentRoot,
    provenance,
  });
  return { status: "matched-export-complete", persistentRoot, exports };
});
