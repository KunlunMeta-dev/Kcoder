import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const NODE_PATH = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const NODE_SHA256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const COMMIT = "10feb0e049e4a3de3aef6c2ecf011e2cac55c66d";
const MOBILE = "apps/kcoder-studio/mobile";
const SHARED = "apps/kcoder-studio/shared";
const MOBILE_TREE = "25146d587811c422695e597f1699c587312bb263";
const SHARED_TREE = "8270e871236a15579a2302e4b46f35642837b1be";
const PACKAGE_LOCK_SHA256 = "848076f520f165128b601b27d96d4d32cf25e8929ee54b672f198b9a4c224e26";
const APP_CONFIG_SHA256 = "4a397b289a5f198b97e8a4a1de269ac40b15173e3e95a0c1241a61311267cd13";
const EXPECTED_ROOTS = [
  { name: "mobile", destination: MOBILE, fileCount: 294, sha256: "84615095cc880eab2179602584d46ddc469db80bd5824502838895c5a4817f92" },
  { name: "studio-shared", destination: SHARED, fileCount: 19, sha256: "5443f5e695e75b82a1365baf90a3c280239bead8855647becfa2c9d67e91fe88" },
];
const EXPECTED_SOURCE_TREE_SHA256 = "b6798c23678c3b4a362c4e6024da536fa9c101df471c375ab202343ca96f1985";
const BASE_TOKEN = "/__kcoder_mobile_mount_v1__";
const MOUNT_OVERLAY = [
  "    experiments: {",
  "      ...appJson.expo.experiments,",
  '      ...(process.env.KCODER_STUDIO_MOBILE_WEB_DEPLOY === "1"',
  `        ? { baseUrl: "${BASE_TOKEN}" } : {}),`,
  "    },",
  "",
].join("\n");
const OUTPUT_ROOT = resolve(repoRoot, "target/private-phone-ux-implementation/matched-before-10feb-source-adapter-20261009");

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const hashJson = value => sha256(Buffer.from(JSON.stringify(value)));
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

async function ownedProcess(context, label, command, args, { cwd = repoRoot, timeoutMs = 60_000 } = {}) {
  const child = context.spawnOwned(label, command, args, {
    cwd,
    env: context.isolatedEnvironment({
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    }),
    windowsHide: true,
  });
  const stdout = [];
  let stdoutBytes = 0;
  let overflow = false;
  let spawnError = null;
  child.stdout?.on("data", chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 4 * 1024 * 1024) stdout.push(Buffer.from(chunk));
    else overflow = true;
  });
  child.once("error", error => { spawnError = error; });
  try {
    await waitFor(() => spawnError || child.exitCode !== null || child.signalCode !== null, timeoutMs, `owned ${label}`, 50, context.abortSignal);
    if (spawnError) throw new Error(`${label} could not start: ${spawnError.name}`);
    assert.equal(child.exitCode, 0, `${label} exited with ${child.signalCode || child.exitCode}`);
    assert.equal(overflow, false, `${label} stdout exceeded the bounded capture`);
    return Buffer.concat(stdout);
  } finally {
    await context.stopOwned(label);
  }
}

function parseGitTree(output, expectedRoots) {
  const rows = output.toString("utf8").split("\0").filter(Boolean).map(raw => {
    const tab = raw.indexOf("\t");
    assert.ok(tab > 0, "Git tree row is malformed");
    const [mode, type, objectId] = raw.slice(0, tab).split(" ");
    const path = raw.slice(tab + 1);
    assert.ok(expectedRoots.some(root => path.startsWith(`${root}/`)), "Git tree row escaped the pinned Mobile/Shared roots");
    assert.ok(mode === "100644" || mode === "100755", "source adapter refuses symlinks or non-regular Git entries");
    assert.equal(type, "blob", "source adapter refuses Git submodules and non-blob entries");
    assert.match(objectId, /^[a-f0-9]{40}$/, "Git blob object id is invalid");
    return { mode, objectId, path };
  });
  rows.sort((left, right) => compareText(left.path, right.path));
  return rows;
}

async function collectFiles(root) {
  const rows = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const path = relative(root, absolute).split(sep).join("/");
      const info = await lstat(absolute);
      assert.equal(info.isSymbolicLink(), false, `Git archive contains a symlink: ${path}`);
      if (info.isDirectory()) await visit(absolute);
      else {
        assert.ok(info.isFile(), `Git archive contains a special file: ${path}`);
        const bytes = await readFile(absolute);
        rows.push({ path, bytes, mode: info.mode });
      }
    }
  }
  await visit(root);
  rows.sort((left, right) => compareText(left.path, right.path));
  return rows;
}

function gitBlobSha1(bytes) {
  return createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
}

function sourceExcluded(name, isDirectory) {
  if (isDirectory && [".expo", ".git", "dist", "node_modules"].includes(name)) return true;
  if (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") return true;
  return /(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name);
}

async function collectExportRoot(root, name, destination) {
  const files = [];
  async function visit(directory, prefix = "") {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      if (sourceExcluded(child.name, child.isDirectory())) continue;
      const absolute = resolve(directory, child.name);
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const info = await lstat(absolute);
      assert.equal(info.isSymbolicLink(), false, `exportable Git source contains a symlink: ${path}`);
      if (info.isDirectory()) await visit(absolute, path);
      else {
        assert.ok(info.isFile(), `exportable Git source contains a special file: ${path}`);
        const bytes = await readFile(absolute);
        files.push({ path, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { name, destination, sha256: hashJson(files), fileCount: files.length };
}

function excludedComplementEntry(name, isDirectory) {
  if (isDirectory && ["node_modules", ".expo", ".git", "dist", "target"].includes(name)) return true;
  if (name === ".env" || /^\.env\.(?!example(?:\.|$))/i.test(name)) return true;
  if ([".npmrc", "credentials.json", "account_credentials.json"].includes(name)) return true;
  if (/(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name)) return true;
  return /\.(?:pem|key|p12|pfx|keystore)$/i.test(name);
}

async function hashComplement(mobileRoot, sharedRoot) {
  const files = [];
  async function append(root, repoRootPath, excluded) {
    async function visit(directory, prefix, excludedTopLevel) {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (excludedComplementEntry(child.name, child.isDirectory()) || excludedTopLevel.has(child.name)) continue;
        const absolute = resolve(directory, child.name);
        const path = prefix ? `${prefix}/${child.name}` : child.name;
        const info = await lstat(absolute);
        assert.equal(info.isSymbolicLink(), false, `complement source contains a symlink: ${path}`);
        if (info.isDirectory()) await visit(absolute, path, new Set());
        else {
          assert.ok(info.isFile(), `complement source contains a special file: ${path}`);
          files.push({ path: `${repoRootPath}/${path}`, sha256: sha256(await readFile(absolute)) });
        }
      }
    }
    await visit(root, "", excluded);
  }
  await append(mobileRoot, MOBILE, new Set(["src"]));
  await append(sharedRoot, SHARED, new Set(["gatewayConnectionBudget.ts"]));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return sha256(Buffer.from(JSON.stringify(files)));
}

async function copyOwnedSource(sourceRoot, destinationRoot, exportFiles) {
  await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  await chmod(destinationRoot, 0o700);
  for (const file of exportFiles) {
    const segments = file.path.split("/");
    const source = resolve(sourceRoot, ...segments);
    const destination = resolve(destinationRoot, ...segments);
    const rel = relative(destinationRoot, destination);
    assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`), "source adapter copy escaped destination");
    let current = destinationRoot;
    for (const segment of segments.slice(0, -1)) {
      current = resolve(current, segment);
      try { await mkdir(current, { recursive: false, mode: 0o700 }); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
      const info = await lstat(current);
      assert.ok(info.isDirectory() && !info.isSymbolicLink(), "source adapter parent must be a real directory");
      await chmod(current, 0o700);
    }
    const sourceInfo = await lstat(source);
    assert.ok(sourceInfo.isFile() && !sourceInfo.isSymbolicLink(), `source adapter input is not a regular file: ${file.path}`);
    const bytes = await readFile(source);
    assert.equal(sha256(bytes), file.sha256, `source adapter input changed while copying: ${file.path}`);
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    await chmod(destination, 0o600);
  }
}

async function writeExclusiveJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

assert.equal(process.execPath, NODE_PATH, "run source adapter with the pinned Node 22.17 executable");
assert.equal(sha256(await readFile(process.execPath)), NODE_SHA256, "pinned Node executable changed");

await runE2E(import.meta.url, {
  testId: "mobile-matched-before-10feb-git-source-adapter",
  kind: "model-independent",
  modelPolicy: "none; only pinned Git source materialization and deploy-mount metadata validation; no Expo export or Browser",
  retainSuccessLogs: true,
}, async context => {
  const gitRoot = (await ownedProcess(context, "source-adapter-git-root", "git", ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
  assert.equal(await realpath(gitRoot), repoRoot, "source adapter runner is outside its fixed repository");
  assert.equal((await ownedProcess(context, "source-adapter-git-format", "git", ["rev-parse", "--show-object-format"])).toString("utf8").trim(), "sha1");
  assert.equal((await ownedProcess(context, "source-adapter-git-commit", "git", ["rev-parse", `${COMMIT}^{commit}`])).toString("utf8").trim(), COMMIT, "10feb Git commit pin changed");
  assert.equal((await ownedProcess(context, "source-adapter-git-mobile-tree", "git", ["rev-parse", `${COMMIT}:${MOBILE}`])).toString("utf8").trim(), MOBILE_TREE, "10feb Mobile Git tree changed");
  assert.equal((await ownedProcess(context, "source-adapter-git-shared-tree", "git", ["rev-parse", `${COMMIT}:${SHARED}`])).toString("utf8").trim(), SHARED_TREE, "10feb Shared Git tree changed");
  const gitTreeOutput = await ownedProcess(context, "source-adapter-git-tree", "git", ["ls-tree", "-r", "-z", "--full-tree", COMMIT, "--", MOBILE, SHARED]);
  const gitRows = parseGitTree(gitTreeOutput, [MOBILE, SHARED]);
  const stageRoot = context.pathInState("archive-source-10feb");
  const archivePath = context.pathInState("archive-source-10feb.tar");
  await mkdir(stageRoot, { recursive: false, mode: 0o700 });
  context.registerTemporaryDirectory("pinned 10feb Git archive staging", stageRoot);
  await ownedProcess(context, "source-adapter-git-archive", "git", ["archive", "--format=tar", `--output=${archivePath}`, COMMIT, MOBILE, SHARED]);
  const archiveBytes = await readFile(archivePath);
  const archiveSha256 = sha256(archiveBytes);
  await ownedProcess(context, "source-adapter-tar-extract", "tar", ["--extract", "--file", archivePath, "--directory", stageRoot, "--no-same-owner"]);

  const appSourceRoot = resolve(stageRoot, "apps/kcoder-studio");
  const materialized = await collectFiles(appSourceRoot);
  const expectedPaths = gitRows.map(row => row.path.slice("apps/kcoder-studio/".length));
  assert.deepEqual(materialized.map(row => row.path), expectedPaths, "10feb archive file list differs from the exact pinned Git trees");
  for (let index = 0; index < materialized.length; index += 1) {
    const actual = materialized[index];
    const expected = gitRows[index];
    assert.equal(gitBlobSha1(actual.bytes), expected.objectId, `10feb Git blob changed: ${expected.path}`);
    assert.equal(Boolean(actual.mode & 0o111), expected.mode === "100755", `10feb Git executable mode changed: ${expected.path}`);
  }

  const mobileRoot = resolve(appSourceRoot, "mobile");
  const sharedRoot = resolve(appSourceRoot, "shared");
  const packageLock = await readFile(resolve(mobileRoot, "package-lock.json"));
  assert.equal(sha256(packageLock), PACKAGE_LOCK_SHA256, "10feb static package-lock pin changed");
  const appConfigPath = resolve(mobileRoot, "app.config.ts");
  const originalAppConfig = await readFile(appConfigPath);
  assert.equal(sha256(originalAppConfig), APP_CONFIG_SHA256, "10feb app.config Git input changed");
  const appConfigText = originalAppConfig.toString("utf8");
  const anchor = "    ...appJson.expo,\n";
  assert.equal(appConfigText.split(anchor).length - 1, 1, "10feb mount overlay anchor must be unique");
  const mountedAppConfig = Buffer.from(appConfigText.replace(anchor, `${anchor}${MOUNT_OVERLAY}`));
  await writeFile(appConfigPath, mountedAppConfig, { flag: "w" });

  const actualRoots = [
    await collectExportRoot(mobileRoot, "mobile", MOBILE),
    await collectExportRoot(sharedRoot, "studio-shared", SHARED),
  ];
  assert.deepEqual(actualRoots, EXPECTED_ROOTS, "10feb mounted source roots differ from the completed matched export input");
  const sourceTreeSha256 = hashJson(actualRoots.map(({ name, destination, sha256: digest }) => ({ name, destination, sha256: digest })));
  assert.equal(sourceTreeSha256, EXPECTED_SOURCE_TREE_SHA256, "10feb mounted source tree differs from the completed matched export input");

  const exportFiles = [];
  for (const [rootPath, repoRelativeRoot] of [[mobileRoot, MOBILE], [sharedRoot, SHARED]]) {
    const rows = await collectExportRootFiles(rootPath, repoRelativeRoot);
    exportFiles.push(...rows);
  }
  exportFiles.sort((left, right) => compareText(left.path, right.path));
  const beforeComplementSha256 = await hashComplement(mobileRoot, sharedRoot);
  const packageLockPath = `${MOBILE}/package-lock.json`;
  const overlayHashes = Object.fromEntries(exportFiles
    .filter(row => row.path !== packageLockPath)
    .map(row => [row.path, row.sha256]));
  const overlayManifestBytes = Buffer.from(`${JSON.stringify(overlayHashes, null, 2)}\n`);
  const adapterParent = resolve(repoRoot, "target/private-phone-ux-implementation");
  assert.equal(await realpath(adapterParent), adapterParent, "private source-adapter parent must be canonical");
  try {
    await lstat(OUTPUT_ROOT);
    assert.fail("10feb source adapter already exists; refusing overwrite");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(OUTPUT_ROOT, { recursive: false, mode: 0o700 });
  await chmod(OUTPUT_ROOT, 0o700);
  let adapterComplete = false;
  context.addCleanup("remove incomplete 10feb source adapter on failure", async () => {
    if (!adapterComplete) {
      const { rm } = await import("node:fs/promises");
      await rm(OUTPUT_ROOT, { recursive: true, force: true });
    }
  });
  const ownedMobileRoot = resolve(OUTPUT_ROOT, MOBILE);
  const ownedSharedRoot = resolve(OUTPUT_ROOT, SHARED);
  await mkdir(resolve(OUTPUT_ROOT, "apps/kcoder-studio"), { recursive: true, mode: 0o700 });
  const mobileExportFiles = exportFiles.filter(row => row.path.startsWith(`${MOBILE}/`));
  const sharedExportFiles = exportFiles.filter(row => row.path.startsWith(`${SHARED}/`));
  await copyOwnedSource(mobileRoot, ownedMobileRoot, mobileExportFiles.map(row => ({ path: row.path.slice(MOBILE.length + 1), sha256: row.sha256 })));
  await copyOwnedSource(sharedRoot, ownedSharedRoot, sharedExportFiles.map(row => ({ path: row.path.slice(SHARED.length + 1), sha256: row.sha256 })));
  await writeExclusiveJson(resolve(OUTPUT_ROOT, "sha256.json"), overlayHashes);
  const adapterMetadata = {
    schemaVersion: 1,
    status: "complete",
    inputKind: "pinned-git-source-adapter-for-matched-before-export",
    sourceCommit: COMMIT,
    gitTrees: { mobile: MOBILE_TREE, shared: SHARED_TREE },
    rawGitBlobCount: gitRows.length,
    copiedExportInputCount: exportFiles.length,
    snapshotOverlayFileCount: Object.keys(overlayHashes).length,
    sourceTreeSha256,
    inputRoots: actualRoots,
    sourceHashExclusionPolicy: "Matches mobile-web-export source omission for .expo/.git/dist/node_modules, dotenv, and secret/credential-named paths; the Mobile package-lock is present only through the verified complement copy and intentionally omitted from sha256.json because the suite does not permit before-mode lockfile overlays.",
    deployMountOverlay: {
      path: `${MOBILE}/app.config.ts`,
      purpose: "five-line build-only deploy-mount parity overlay; original Git app.config bytes were verified before insertion",
      baseFileSha256: sha256(originalAppConfig),
      insertedBlockSha256: sha256(Buffer.from(MOUNT_OVERLAY)),
      updatedFileSha256: sha256(mountedAppConfig),
      baseToken: BASE_TOKEN,
    },
    packageLock: { sha256: sha256(packageLock), includedInComplement: true, includedInSha256Overlay: false, executed: false },
    beforeComplementSha256,
    sha256ManifestSha256: sha256(overlayManifestBytes),
    archiveSha256,
    frozenAtUtc: new Date().toISOString(),
  };
  await writeExclusiveJson(resolve(OUTPUT_ROOT, "source-adapter.json"), adapterMetadata);
  assert.equal(await realpath(OUTPUT_ROOT), OUTPUT_ROOT, "10feb source adapter output must not traverse a symlink");

  const ownedRoots = [
    await collectExportRoot(ownedMobileRoot, "mobile", MOBILE),
    await collectExportRoot(ownedSharedRoot, "studio-shared", SHARED),
  ];
  assert.deepEqual(ownedRoots, EXPECTED_ROOTS, "owned 10feb source adapter differs from the completed matched input roots");
  assert.equal(await hashComplement(ownedMobileRoot, ownedSharedRoot), beforeComplementSha256, "owned 10feb complement does not match the pinned adapter value");
  const ownedHashes = JSON.parse(await readFile(resolve(OUTPUT_ROOT, "sha256.json"), "utf8"));
  assert.deepEqual(ownedHashes, overlayHashes, "owned before snapshot overlay differs from the pinned source bytes");

  const result = {
    status: "passed",
    outputRoot: relative(repoRoot, OUTPUT_ROOT),
    sourceCommit: COMMIT,
    rawGitBlobCount: gitRows.length,
    exportInputFileCount: exportFiles.length,
    beforeSnapshotOverlayFileCount: Object.keys(overlayHashes).length,
    sourceTreeSha256,
    beforeComplementSha256,
    archiveSha256,
    sha256ManifestSha256: sha256(overlayManifestBytes),
    metadataSha256: sha256(await readFile(resolve(OUTPUT_ROOT, "source-adapter.json"))),
    sourceRoots: ownedRoots,
    deployMountOverlay: adapterMetadata.deployMountOverlay,
    packageLock: adapterMetadata.packageLock,
  };
  await context.writeArtifactJson("before-source-adapter.json", result);
  adapterComplete = true;
  return result;
});

async function collectExportRootFiles(root, repoRootPath) {
  const rows = [];
  async function visit(directory, prefix = "") {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      if (sourceExcluded(child.name, child.isDirectory())) continue;
      const absolute = resolve(directory, child.name);
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const info = await lstat(absolute);
      assert.equal(info.isSymbolicLink(), false, `export input contains a symlink: ${path}`);
      if (info.isDirectory()) await visit(absolute, path);
      else {
        assert.ok(info.isFile(), `export input contains a special file: ${path}`);
        const bytes = await readFile(absolute);
        rows.push({ path: `${repoRootPath}/${path}`, sha256: sha256(bytes) });
      }
    }
  }
  await visit(root);
  return rows;
}
