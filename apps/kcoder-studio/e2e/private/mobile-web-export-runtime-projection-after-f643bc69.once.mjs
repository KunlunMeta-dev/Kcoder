// One-off static Mobile Web export from a pinned current AFTER source plus a
// private read-only runtime/TaskTranscript projection diagnostic overlay.
// This file is intentionally outside the registered E2E suite inventory.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const execFileAsync = promisify(execFile);
const baseCommit = "f643bc6979b7e4122ac88bf4ca50ff63b7ea9ffc";
const integrationRelativeRoot = ".";
const integrationRoot = resolve(repoRoot, integrationRelativeRoot);
const candidateFreezeIntegrationHead = "fbbe8e933639407878d6a90c68cb0fc793a795ac";
const integrationHead = "09d1e88342909b36237a571774d2987fa2a8556c";
const beforeRelativeRoot = "../../target/private-phone-ux-implementation/after-follow-before-f643bc69-scroll-follow-500-20261008.private/source";
const beforeRoot = resolve(repoRoot, beforeRelativeRoot);
const beforeDigest = "1c01f1b6ca6d3eebedb9146ceb3ed38811d5c22e5d48b9ea9ce9c1b497ec43ff";
const beforeManifestSha256 = "0de09424e70fcdf52272d99cd5e90719451f43f0f0cf077b8bcb9782b288a12f";
const overlayManifestRelativePath = "target/private-phone-ux-implementation/runtime-projection-diagnostic-after-f643bc69-20261008/overlay-manifest.json";
const overlayManifestPath = resolve(integrationRoot, overlayManifestRelativePath);
const overlayManifestSha256 = "2efaa9b71d0bcd783f0d57769b7a6646da8d29b6985c03d6dca67b02f37e3e62";
const overlaySourceDigest = "001137f91cc8e336f85a4a2f230dd1180b4908ed71bef7fa25d4ae0cc78a95c2";
const candidateRelativeRoot = "target/private-phone-ux-implementation/runtime-projection-diagnostic-after-f643bc69-20261008/source";
const candidateRoot = resolve(repoRoot, candidateRelativeRoot);
const candidateDigest = "91176056e63df66d8f8134ce382e9d10727f65545e965447cfd186ca1258e36b";
const candidateManifestSha256 = "dda5b83f7a52653d0ca95af8900daa9e85888db157c66ae2ca9157532e78b021";
const candidateFileCount = 313;
const candidateMobileFileCount = 294;
const candidateSharedFileCount = 19;
const beforeCandidateFileCount = 312;
const overlayFileCount = 3;
const dependencyRelativeRoot = "../../target/private-phone-ux-implementation/mobile-dependency-input-pinned";
const dependencyRoot = resolve(repoRoot, dependencyRelativeRoot);
const dependencySourceSha256 = "d91f89f1237d2139ef31ee75565230105014536dc5c9a8c34bf436d0bcc7340c";
const dependencyOwnedSha256 = "754d1db10bd502faeb0b6e82820d455cae680166008a443f7397457f1ef21d29";
const dependencyPackageLockSha256 = "67c2d1c16857f0ed0f6d2ecb3dcf753f26a268b0f1675c1553018e37e9d231a3";
const helperOverlayRelativeRoot = ".";
const helperOverlayRoot = resolve(repoRoot, helperOverlayRelativeRoot);
const helperOverlayHead = "09d1e88342909b36237a571774d2987fa2a8556c";
const archivedExporterRelativePath = "target/private-phone-ux-implementation/owned-export-driver-archive-20261008/source/mobile-web-export-follow-after-f643bc69.once.mjs";
const archivedExporterSha256 = "001809f7aafe1cf613f797ece827582c166b785d289212e8fed8778fb5c55206";
const helperPins = new Map([
  ["apps/kcoder-studio/e2e/harness/mobile-web-export.mjs", "fbbd2ed8591c8c22cf6c683b024d647610b9df6e568c300ffb1acc13fbbe4b36"],
  ["apps/kcoder-studio/e2e/harness/run-context.mjs", "94f0c27306f8944cbd10f1835227a408c51a0b558981d846832bb297c5e5cf11"],
  ["apps/kcoder-studio/e2e/harness/retention.mjs", "9df5193dc1f4bd5565731cf92d0154bb8f3993e8d3c7c3d98f530c8738716532"],
  ["apps/kcoder-studio/e2e/harness/owned-process.mjs", "40a230721ead1ff78877c1b2815aafd220279bccd43d15d78303f30a59cb78af"],
]);
const nodeExecutable = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const nodeSha256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const portableRoot = resolve(
  repoRoot,
  "target/private-phone-ux-implementation/mobile-web-export-runtime-projection-after-f643bc69-20261008",
);
const portableParent = resolve(repoRoot, "target/private-phone-ux-implementation");
const portableManifestPath = `${portableRoot}-manifest.json`;
const portableProvenancePath = `${portableRoot}-provenance.json`;
const sourceDirectories = new Set([".expo", ".git", "dist", "node_modules"]);
const dependencyFileExclusions = new Set([".env", ".npmrc", "credentials.json", "account_credentials.json"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodepoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceEntryOmitted(path) {
  return path.split("/").some(name =>
    sourceDirectories.has(name) ||
    (/^\.env(?:\..+)?$/i.test(name) && name.toLowerCase() !== ".env.example") ||
    /(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name),
  );
}

async function assertPrivateDirectory(path, label) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a real directory`);
  assert.equal(await realpath(path), resolve(path), `${label} must be canonical`);
  if (typeof process.getuid === "function") assert.equal(info.uid, process.getuid(), `${label} owner differs`);
  assert.equal(info.mode & 0o077, 0, `${label} must not grant group or other access`);
  return info;
}

async function assertPathAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.fail(`${label} already exists; refusing to replace it`);
}

async function walkRegularFiles(root) {
  const files = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const info = await lstat(absolute);
      assert.ok(!info.isSymbolicLink(), `source contains a symlink: ${relative(root, absolute)}`);
      if (info.isDirectory()) await visit(absolute);
      else if (info.isFile()) files.push(relative(root, absolute).split(sep).join("/"));
      else assert.fail(`source contains a special file: ${relative(root, absolute)}`);
    }
  }
  await visit(root);
  return files.sort(compareCodepoints);
}

async function verifyCandidate() {
  await assertPrivateDirectory(candidateRoot, "frozen Mobile source root");
  const metadataBytes = await readFile(join(candidateRoot, "metadata.json"));
  const metadata = JSON.parse(metadataBytes);
  assert.equal(metadata.status, "source-frozen-static");
  assert.equal(metadata.baseCommit, baseCommit);
  assert.equal(metadata.baseSourceRoot, beforeRelativeRoot);
  assert.equal(metadata.baseSourceDigest, beforeDigest);
  assert.equal(metadata.baseManifestSha256, beforeManifestSha256);
  assert.equal(metadata.integrationRoot, integrationRelativeRoot);
  assert.equal(metadata.integrationHead, candidateFreezeIntegrationHead);
  assert.equal(metadata.overlayManifestPath, overlayManifestRelativePath);
  assert.equal(metadata.overlayManifestSha256, overlayManifestSha256);
  assert.equal(metadata.overlaySourceDigest, overlaySourceDigest);
  assert.equal(metadata.sourceDigest, candidateDigest);
  assert.equal(metadata.sourceFiles, candidateFileCount);
  assert.equal(metadata.sourceDigestEncoding, "sha256 of codepoint-sorted lines: sha256 + two spaces + repo-relative path + LF");
  assert.equal(metadata.overlayProductCount, 0);
  assert.equal(metadata.overlayTestCount, 3);

  const manifestPath = join(candidateRoot, "sha256.json");
  const manifestBytes = await readFile(manifestPath);
  assert.equal(sha256(manifestBytes), candidateManifestSha256, "source manifest bytes changed");
  const manifest = JSON.parse(manifestBytes);
  const entries = Object.entries(manifest);
  assert.equal(entries.length, candidateFileCount);
  assert.equal(metadata.manifestDigest, candidateManifestSha256);

  const beforeManifestBytes = await readFile(join(beforeRoot, "sha256.json"));
  assert.equal(sha256(beforeManifestBytes), beforeManifestSha256, "pinned 312-file AFTER base manifest changed");
  const beforeManifest = JSON.parse(beforeManifestBytes.toString("utf8"));
  assert.equal(Object.keys(beforeManifest).length, beforeCandidateFileCount);
  const overlayManifestBytes = await readFile(overlayManifestPath);
  assert.equal(sha256(overlayManifestBytes), overlayManifestSha256, "private diagnostic overlay manifest changed");
  const overlayManifest = JSON.parse(overlayManifestBytes.toString("utf8"));
  assert.equal(overlayManifest.sourceDigest, overlaySourceDigest);
  assert.equal(overlayManifest.productFileCount, 0);
  assert.equal(overlayManifest.diagnosticFileCount, 3);
  assert.equal(overlayManifest.count, overlayFileCount);
  const overlay = new Map(overlayManifest.files.map(entry => [entry.path, entry.sha256]));
  assert.equal(overlay.size, overlayFileCount);
  const expectedAfter = new Map(Object.entries(beforeManifest));
  for (const [path, digest] of overlay) expectedAfter.set(path, digest);
  assert.equal(expectedAfter.size, candidateFileCount, "current AFTER plus exact test-only diagnostic overlay must equal candidate count");
  assert.deepEqual(
    Object.keys(manifest).sort(compareCodepoints),
    [...expectedAfter.keys()].sort(compareCodepoints),
    "diagnostic source path set must be exactly current AFTER plus the three pinned test-only entries",
  );
  for (const [path, digest] of expectedAfter) {
    assert.equal(manifest[path], digest, `frozen AFTER source differs from its pinned base+delta: ${path}`);
  }
  const changedPaths = [...expectedAfter.keys()].filter(path => beforeManifest[path] !== expectedAfter.get(path)).sort(compareCodepoints);
  assert.deepEqual(changedPaths, [...overlay.keys()].sort(compareCodepoints), "diagnostic delta differs from the three pinned test-only entries");
  assert.equal(changedPaths.length, 3);
  assert.ok(changedPaths.every(path => path.startsWith("apps/kcoder-studio/mobile/")));

  const actualPaths = (await walkRegularFiles(candidateRoot))
    .filter(path => path !== "metadata.json" && path !== "sha256.json");
  assert.deepEqual(actualPaths, entries.map(([path]) => path).sort(compareCodepoints), "frozen source tree has missing or extra files");
  for (const [path, expected] of entries) {
    assert.ok(path.startsWith("apps/kcoder-studio/mobile/") || path.startsWith("apps/kcoder-studio/shared/"), `unexpected source root: ${path}`);
    assert.equal(sourceEntryOmitted(path), false, `candidate contains a filtered or secret-named path: ${path}`);
    assert.equal(sha256(await readFile(join(candidateRoot, path))), expected, `frozen source hash mismatch: ${path}`);
  }
  const mobileCount = entries.filter(([path]) => path.startsWith("apps/kcoder-studio/mobile/")).length;
  const sharedCount = entries.filter(([path]) => path.startsWith("apps/kcoder-studio/shared/")).length;
  assert.equal(mobileCount, candidateMobileFileCount);
  assert.equal(sharedCount, candidateSharedFileCount);
  const sourceRows = entries
    .map(([path, digest]) => `${digest}  ${path}\n`)
    .sort((left, right) => compareCodepoints(
      left.slice(left.indexOf("  ") + 2),
      right.slice(right.indexOf("  ") + 2),
    ))
    .join("");
  assert.equal(sha256(sourceRows), candidateDigest, "manifest aggregate digest differs");
  assert.equal(manifest["apps/kcoder-studio/mobile/package.json"], beforeManifest["apps/kcoder-studio/mobile/package.json"]);
  assert.equal(manifest["apps/kcoder-studio/mobile/package-lock.json"], beforeManifest["apps/kcoder-studio/mobile/package-lock.json"]);
  assert.equal(metadata.packageJsonSha256, beforeManifest["apps/kcoder-studio/mobile/package.json"]);
  assert.equal(metadata.packageLockSha256, beforeManifest["apps/kcoder-studio/mobile/package-lock.json"]);
  return {
    metadata,
    manifest,
    overlayManifestSha256,
    changedPaths,
    includedFileCount: entries.length,
    mobileCount,
    sharedCount,
  };
}

function excludedDependencyEntry(name, isDirectory) {
  if (isDirectory && name === ".vite") return "generated-vite-cache-directory";
  if (name === ".env" || /^\.env\.(?!example(?:\.|$))/i.test(name)) return "environment-file";
  if (dependencyFileExclusions.has(name)) return "credential-file";
  if (/(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(name)) return "credential-named-file";
  if (/\.(?:pem|key|p12|pfx|keystore)$/i.test(name)) return "cryptographic-key-material";
  return null;
}

async function hashPinnedDependencyRoot(root) {
  const rootReal = await realpath(root);
  const files = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const category = excludedDependencyEntry(child.name, child.isDirectory());
      assert.equal(category, null, `pinned dependencies contain excluded ${category}: ${child.name}`);
      const path = resolve(directory, child.name);
      const info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), `pinned dependencies contain a symlink: ${relative(rootReal, path)}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        const bytes = await readFile(path);
        files.push({ path: relative(rootReal, path).split(sep).join("/"), size: bytes.length, sha256: sha256(bytes) });
      } else assert.fail(`pinned dependencies contain a special file: ${relative(rootReal, path)}`);
    }
  }
  await visit(rootReal);
    files.sort((left, right) => left.path.localeCompare(right.path));
  const rootDigest = sha256(Buffer.from(JSON.stringify(files)));
  return sha256(Buffer.from(JSON.stringify([{
    name: "mobile-dependencies",
    destination: "apps/kcoder-studio/mobile/node_modules",
    sha256: rootDigest,
  }])));
}

async function verifyPinnedInputs() {
  const actualNode = await realpath(process.execPath);
  assert.equal(actualNode, nodeExecutable, "process is not running with the pinned Node executable");
  assert.equal(process.version, "v22.17.0", "Node version differs from the pinned runtime");
  assert.equal(sha256(await readFile(actualNode)), nodeSha256, "pinned Node executable bytes changed");

  const archivedExporterPath = resolve(repoRoot, archivedExporterRelativePath);
  assert.equal(sha256(await readFile(archivedExporterPath)), archivedExporterSha256, "archived successful exporter source changed");
  const exporterSourcePath = fileURLToPath(import.meta.url);
  const exporterSourceSha256 = sha256(await readFile(exporterSourcePath));

  const parent = await realpath(portableParent);
  assert.equal(parent, portableParent, "portable output parent must be canonical");
  await assertPathAbsent(portableRoot, "portable output root");
  await assertPathAbsent(portableManifestPath, "portable bundle manifest");
  await assertPathAbsent(portableProvenancePath, "portable provenance");

  const dependencyInfo = await assertPrivateDirectory(dependencyRoot, "pinned dependency root");
  assert.equal(dependencyInfo.mode & 0o777, 0o700, "pinned dependency root mode changed");
  const dependencyPackageLock = await readFile(join(dependencyRoot, ".package-lock.json"));
  assert.equal(sha256(dependencyPackageLock), dependencyPackageLockSha256, "pinned dependency lock bytes changed");
  await readFile(join(dependencyRoot, "expo/package.json"), "utf8");
  const dependencyDigest = await hashPinnedDependencyRoot(dependencyRoot);
  assert.equal(dependencyDigest, dependencySourceSha256, "pinned dependency content differs from the recorded source tree");

  return {
    node: { executable: actualNode, version: process.version, sha256: nodeSha256 },
    exporterSource: {
      path: relative(repoRoot, exporterSourcePath).split(sep).join("/"),
      sha256: exporterSourceSha256,
      derivedFrom: archivedExporterRelativePath,
      archivedSha256: archivedExporterSha256,
    },
    dependency: {
      root: dependencyRoot,
      mode: "0700",
      packageLockSha256: dependencyPackageLockSha256,
      sourceTreeSha256: dependencyDigest,
      priorVerifiedOwnedTreeSha256: dependencyOwnedSha256,
      reuse: "existing immutable private pin; no install or active node_modules read",
    },
  };
}

async function verifyPinnedExportHelper() {
  assert.equal(await realpath(helperOverlayRoot), helperOverlayRoot, "fixed helper overlay root must be canonical");
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: helperOverlayRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  })).stdout.trim();
  assert.equal(head, helperOverlayHead, "fixed helper overlay checkout changed");
  const verified = [];
  for (const [relativePath, expected] of helperPins) {
    const path = resolve(helperOverlayRoot, relativePath);
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `fixed helper input is not regular: ${relativePath}`);
    assert.equal(await realpath(path), path, `fixed helper input is not canonical: ${relativePath}`);
    assert.equal(sha256(await readFile(path)), expected, `fixed helper input changed: ${relativePath}`);
    const mainCheckoutPath = resolve(repoRoot, relativePath);
    const matchesMainCheckout = relativePath === "apps/kcoder-studio/e2e/harness/mobile-web-export.mjs"
      ? null
      : sha256(await readFile(mainCheckoutPath)) === expected;
    if (matchesMainCheckout === false) {
      assert.fail(`fixed helper dependency differs from the matching main checkout file: ${relativePath}`);
    }
    verified.push({ path: relativePath, sha256: expected, matchesMainCheckout });
  }
  return { root: helperOverlayRoot, gitHead: head, files: verified };
}

async function loadPinnedExportHelper() {
  const source = await verifyPinnedExportHelper();
  const helperPath = resolve(helperOverlayRoot, "apps/kcoder-studio/e2e/harness/mobile-web-export.mjs");
  const module = await import(pathToFileURL(helperPath).href);
  assert.equal(typeof module.exportMobileWeb, "function", "fixed overlay lacks exportMobileWeb");
  return { exportMobileWeb: module.exportMobileWeb, source };
}

async function copyArtifactTree(sourceRoot, destinationRoot, { rootAlreadyCreated = false } = {}) {
  if (rootAlreadyCreated) {
    const rootInfo = await lstat(destinationRoot);
    assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "pre-created destination root must be a real directory");
    assert.equal((await readdir(destinationRoot)).length, 0, "pre-created destination root must be empty");
  } else {
    await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  }
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const source = resolve(sourceRoot, entry.name);
    const destination = resolve(destinationRoot, entry.name);
    const info = await lstat(source);
    assert.ok(!info.isSymbolicLink(), `export output contains a symlink: ${entry.name}`);
    if (info.isDirectory()) await copyArtifactTree(source, destination);
    else if (info.isFile()) await copyFile(source, destination, constants.COPYFILE_EXCL);
    else assert.fail(`export output contains a non-regular file: ${entry.name}`);
  }
}

async function hashArtifactTree(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      const info = await lstat(path);
      assert.ok(!info.isSymbolicLink(), `portable export contains a symlink: ${relativePath}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        const bytes = await readFile(path);
        files.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
      } else assert.fail(`portable export contains a special file: ${relativePath}`);
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, sha256: sha256(Buffer.from(JSON.stringify(files))) };
}

async function verifyCopyArtifactTreePreflight() {
  const tempRoot = await mkdtemp(join(tmpdir(), "kc-mobile-export-copy-preflight-"));
  try {
    const sourceRoot = join(tempRoot, "source");
    const destinationRoot = join(tempRoot, "destination");
    await mkdir(join(sourceRoot, "nested"), { recursive: true, mode: 0o700 });
    await writeExclusive(join(sourceRoot, "root.txt"), "root payload\n");
    await writeExclusive(join(sourceRoot, "nested", "child.txt"), "nested payload\n");
    const source = await hashArtifactTree(sourceRoot);

    await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
    await copyArtifactTree(sourceRoot, destinationRoot, { rootAlreadyCreated: true });
    const copied = await hashArtifactTree(destinationRoot);
    assert.deepEqual(copied.files, source.files, "copy must preserve both root and nested file bytes");
    assert.equal(copied.sha256, source.sha256, "copy must preserve the tree digest");
    assert.equal(copied.files.length, 2, "preflight fixture must contain exactly two files");

    await assert.rejects(
      copyArtifactTree(sourceRoot, destinationRoot, { rootAlreadyCreated: true }),
      error => error?.code === "ERR_ASSERTION" && /pre-created destination root must be empty/.test(error.message),
      "re-entering a populated target must reject before writing",
    );
    assert.deepEqual(await hashArtifactTree(destinationRoot), copied, "rejected re-entry must not alter copied bytes");
    return { status: "passed", fileCount: copied.files.length, sha256: copied.sha256, reentryRejectedWithoutMutation: true };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeExclusive(path, value) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
}

const copyPreflightOnly = process.argv.includes("--copy-preflight-only");
const inputPreflightOnly = process.argv.includes("--input-preflight-only");
if (copyPreflightOnly) {
  const result = await verifyCopyArtifactTreePreflight();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (inputPreflightOnly) {
  const pinnedHelper = await loadPinnedExportHelper();
  const candidate = await verifyCandidate();
  const pinned = await verifyPinnedInputs();
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    candidateRoot,
    candidateDigest,
    candidateManifestSha256,
    candidateFiles: candidate.includedFileCount,
    mobileFiles: candidate.mobileCount,
    sharedFiles: candidate.sharedCount,
    changedPaths: candidate.changedPaths,
    overlayManifestSha256: candidate.overlayManifestSha256,
    node: pinned.node,
    exporterSource: pinned.exporterSource,
    dependency: pinned.dependency,
    exportHelper: pinnedHelper.source,
    outputRootsAbsent: true,
  })}\n`);
}

if (!copyPreflightOnly && !inputPreflightOnly) await runE2E(
  import.meta.url,
  {
    testId: "mobile-web-export-runtime-projection-after-f643bc69",
    tier: "full-integration",
    modelPolicy: "model-independent static export only; no Browser, Gateway, Provider, or user session",
    retainSuccessLogs: true,
    cleanupTimeoutMs: 20_000,
    survivorCheckTimeoutMs: 5_000,
  },
  async context => {
    let portableCreated = false;
    const createdSidecars = [];
    try {
      const pinnedHelper = await loadPinnedExportHelper();
      const candidate = await verifyCandidate();
      const pinned = await verifyPinnedInputs();
      const mobileRoot = join(candidateRoot, "apps/kcoder-studio/mobile");
      const sharedRoot = join(candidateRoot, "apps/kcoder-studio/shared");
      const preflight = {
        status: "preflight-passed",
        baseCommit,
        integrationRoot,
        integrationHead,
        candidateFreezeIntegrationHead,
        overlayManifestPath,
        overlayManifestSha256: candidate.overlayManifestSha256,
        overlaySourceDigest,
        overlayFileCount,
        changedPaths: candidate.changedPaths,
        candidateRoot,
        candidateDigest,
        candidateManifestSha256,
        includedFileCount: candidate.includedFileCount,
        sourceRootFiles: { mobile: candidate.mobileCount, shared: candidate.sharedCount },
        exportHelper: pinnedHelper.source,
        node: pinned.node,
        exporterSource: pinned.exporterSource,
        dependency: pinned.dependency,
        portableRoot,
      };
      await context.writeArtifactJson("build-inputs.json", preflight);

      const exported = await pinnedHelper.exportMobileWeb(context, {
        mobileRoot,
        sourceRoots: [
          { name: "mobile", path: mobileRoot, destination: "apps/kcoder-studio/mobile" },
          { name: "studio-shared", path: sharedRoot, destination: "apps/kcoder-studio/shared" },
        ],
        dependencyRoot,
        label: "runtime-projection-after-f643bc69",
        outputName: "mobile-web-export-runtime-projection-after-f643bc69",
        timeoutMs: 180_000,
      });
      assert.deepEqual(
        await verifyPinnedExportHelper(),
        pinnedHelper.source,
        "fixed exporter helper or dependency closure changed during export",
      );
      const buildManifest = JSON.parse(await readFile(exported.bundleManifestPath, "utf8"));
      assert.equal(buildManifest.status, "complete", buildManifest.error ?? "Mobile Web export failed");
      assert.equal(buildManifest.sourceUnchanged, true);
      assert.equal(buildManifest.snapshotCopyMatchesSource, true);
      assert.equal(buildManifest.snapshotUnchangedDuringExport, true);
      assert.equal(buildManifest.dependencyProvenance.sourceUnchanged, true);
      assert.equal(buildManifest.terminalHookChangesOnlyGeneratedHtml, true);
      assert.equal(exported.sourceRoots.length, 2);
      assert.deepEqual(exported.sourceRoots.map(root => [root.name, root.fileCount]), [["mobile", candidateMobileFileCount], ["studio-shared", candidateSharedFileCount]]);
      assert.equal(exported.dependencySourceTreeSha256, dependencySourceSha256);
      assert.equal(exported.dependencyOwnedTreeSha256, dependencyOwnedSha256);

      await mkdir(portableRoot, { recursive: false, mode: 0o700 });
      portableCreated = true;
      await copyArtifactTree(exported.path, portableRoot, { rootAlreadyCreated: true });
      const copied = await hashArtifactTree(portableRoot);
      assert.deepEqual(copied.files, exported.bundleFiles);
      assert.equal(copied.sha256, exported.bundleSha256);
      assert.equal(copied.files.length, exported.bundleFileCount);
      const indexHtmlSha256 = copied.files.find(file => file.path === "index.html")?.sha256 ?? null;
      assert.ok(indexHtmlSha256, "portable export is missing index.html");

      const manifestBytes = await readFile(exported.bundleManifestPath);
      await writeExclusive(portableManifestPath, manifestBytes);
      createdSidecars.push(portableManifestPath);
      const provenance = {
        status: "complete",
        kind: "private-diagnostic-copy-of-builder-export-v1",
        exportPerformedInMeasurementRun: false,
        wrapperSource: relative(repoRoot, fileURLToPath(import.meta.url)).split(sep).join("/"),
        wrapperSourceSha256: pinned.exporterSource.sha256,
        wrapperSourceOrigin: {
          path: archivedExporterRelativePath,
          sha256: archivedExporterSha256,
          relationship: "copied from the successful 001809 AFTER exporter; constants, source-delta validation, and derived provenance identity updated for this private diagnostic candidate",
        },
        diagnosticEvidenceScope: "bounded TaskRuntime snapshot and committed TaskTranscript projection only; no RPC frame entry or accepted-frame claim",
        sourceCommit: baseCommit,
        sourceOrigin: {
          kind: "immutable-current-after-plus-private-runtime-projection-diagnostic-overlay",
          baseCommit,
          baseCandidateRoot: beforeRoot,
          baseCandidateDigest: beforeDigest,
          baseCandidateManifestSha256: beforeManifestSha256,
          integrationRoot,
          integrationHead,
          candidateFreezeIntegrationHead,
          overlayManifestPath,
          overlayManifestSha256,
          overlaySourceDigest,
          overlayFileCount,
          changedPaths: candidate.changedPaths,
        },
        candidateRoot,
        candidateDigest,
        candidateManifestSha256,
        candidateFiles: candidate.includedFileCount,
        candidateMobileManifestFiles: candidate.mobileCount,
        candidateSharedManifestFiles: candidate.sharedCount,
        candidateManifestPath: join(candidateRoot, "sha256.json"),
        includedFileCount: candidate.includedFileCount,
        sourceRootFiles: { mobile: candidateMobileFileCount, shared: candidateSharedFileCount },
        sourceCompleteness: {
          manifestFileCount: candidate.includedFileCount,
          workspaceComplementCopied: false,
          candidateMobileManifestFiles: candidate.mobileCount,
          candidateSharedManifestFiles: candidate.sharedCount,
          sourceRootsIndividuallyPinned: true,
        },
        sourceComplementSha256: null,
        exportHelper: pinnedHelper.source,
        sourceTreeSha256: exported.sourceTreeSha256,
        sourceRoots: exported.sourceRoots,
        sourceUnchanged: buildManifest.sourceUnchanged,
        snapshotCopyMatchesSource: buildManifest.snapshotCopyMatchesSource,
        snapshotUnchangedDuringExport: buildManifest.snapshotUnchangedDuringExport,
        dependency: {
          root: dependencyRoot,
          packageLockSha256: dependencyPackageLockSha256,
          sourceTreeSha256: exported.dependencySourceTreeSha256,
          ownedTreeSha256: exported.dependencyOwnedTreeSha256,
          sourceUnchanged: buildManifest.dependencyProvenance.sourceUnchanged,
        },
        dependencyInput: {
          sourceRoot: dependencyRoot,
          privateRoot: dependencyRoot,
          sourceTreeSha256: exported.dependencySourceTreeSha256,
          ownedTreeSha256: exported.dependencyOwnedTreeSha256,
          sourceUnchanged: buildManifest.dependencyProvenance.sourceUnchanged,
          copySemantics: "reused the existing pinned dependency source; exporter created its isolated owned build copy",
        },
        dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
        node: pinned.node,
        exporterPids: {
          dependencyCopier: exported.dependencyCopierPid,
          terminalHtmlBuilder: exported.terminalWebView.builderPid,
          expoExporter: buildManifest.exporterPid,
        },
        bundlePath: portableRoot,
        bundleRoot: portableRoot,
        bundleSha256: copied.sha256,
        bundleFileCount: copied.files.length,
        indexHtmlSha256,
        bundleManifestPath: portableManifestPath,
        bundleManifest: portableManifestPath,
        exportManifestPath: portableManifestPath,
        manifestPath: portableManifestPath,
        portableProvenancePath,
      };
      const provenanceBytes = `${JSON.stringify(provenance, null, 2)}\n`;
      await writeExclusive(portableProvenancePath, provenanceBytes);
      createdSidecars.push(portableProvenancePath);
      await context.writeArtifactJson("portable-export-provenance.json", provenance);
      return {
        candidateDigest,
        sourceTreeSha256: exported.sourceTreeSha256,
        dependencySourceTreeSha256: exported.dependencySourceTreeSha256,
        dependencyOwnedTreeSha256: exported.dependencyOwnedTreeSha256,
        bundleSha256: copied.sha256,
        bundleFileCount: copied.files.length,
        indexHtmlSha256,
        bundlePath: portableRoot,
        bundleManifestPath: portableManifestPath,
        provenancePath: portableProvenancePath,
      };
    } catch (error) {
      const cleanupErrors = [];
      for (const path of createdSidecars.reverse()) {
        await rm(path, { force: true }).catch(cleanupError => cleanupErrors.push(cleanupError));
      }
      if (portableCreated) {
        await rm(portableRoot, { recursive: true, force: true }).catch(cleanupError => cleanupErrors.push(cleanupError));
      }
      if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "export failed and owned portable output cleanup also failed");
      throw error;
    }
  },
);
