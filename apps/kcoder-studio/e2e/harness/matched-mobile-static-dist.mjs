import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { buildGatewayMobileWebManifest, serializeGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { copyOfficialMobileStaticDist, inspectOfficialMobileStaticDist } from "./mobile-static-dist-input.mjs";
import { repoRoot } from "./run-context.mjs";

const exportManifestName = "export-manifest.json";
const gatewayManifestName = "kcoder-mobile-web.json";
const expectedBundleFileCount = 37;
const maximumExportManifestBytes = 1024 * 1024;
const maximumBundleFileBytes = 32 * 1024 * 1024;
const maximumBundleBytes = 256 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;

/**
 * Materialize a previously matched Mobile Web bundle as the existing Gateway
 * static-dist format. This is a derived deployment adapter, not an Expo export
 * receipt and not a new builder run.
 */
export async function materializeMatchedMobileStaticDist(context, {
  bundleRoot,
  exportManifestPath,
  expectedExportManifestSha256,
  expectedBundleSha256,
  expectedSourceTreeSha256,
  expectedDependencySourceTreeSha256,
  expectedDependencyOwnedTreeSha256,
  expectedDependencyFileCount,
  expectedInputRoots,
  outputName = "matched-mobile-static-dist",
  stagingName = "matched-mobile-static-dist-source",
  artifactName = "matched-deploy-mounted-mobile-dist.json",
  comparisonId = "matched-export",
} = {}) {
  validatePins({
    expectedExportManifestSha256,
    expectedBundleSha256,
    expectedSourceTreeSha256,
    expectedDependencySourceTreeSha256,
    expectedDependencyOwnedTreeSha256,
    expectedDependencyFileCount,
    expectedInputRoots,
  });
  assert.ok(typeof comparisonId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(comparisonId), "matched comparison ID is invalid");
  assert.ok(typeof outputName === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(outputName), "owned Mobile dist name is invalid");
  assert.ok(typeof stagingName === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(stagingName), "matched staging name is invalid");
  assert.ok(typeof artifactName === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/.test(artifactName), "matched evidence artifact name is invalid");
  assert.ok(outputName !== stagingName, "matched staging and final output names must differ");
  assert.ok(context && typeof context.pathInState === "function", "a RunContext is required for the matched deploy-mounted dist");
  assert.ok(typeof context.registerTemporaryDirectory === "function", "RunContext temporary-directory registration is required");
  assert.ok(typeof context.writeArtifactJson === "function", "RunContext artifact writing is required");

  const source = await verifyMatchedExportInput({
    bundleRoot,
    exportManifestPath,
    expectedExportManifestSha256,
    expectedBundleSha256,
    expectedSourceTreeSha256,
    expectedDependencySourceTreeSha256,
    expectedDependencyOwnedTreeSha256,
    expectedDependencyFileCount,
    expectedInputRoots,
  });
  const { stateDir, stagingRoot, ownedRoot } = await validateRunContextPaths(context, stagingName, outputName);
  await assertPathAbsent(stagingRoot, "matched Mobile dist staging path already exists");
  await assertPathAbsent(ownedRoot, "matched Mobile dist output path already exists");

  await mkdir(stagingRoot, { recursive: false, mode: 0o700 });
  await chmod(stagingRoot, 0o700);
  try {
    context.registerTemporaryDirectory("matched deploy-mounted Mobile dist manifest staging", stagingRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  for (const row of source.bundleFiles) {
    const segments = safeBundlePath(row.path);
    const sourceFile = await readMatchedBundleFile(source.bundleRoot, segments, row);
    const destination = resolve(stagingRoot, ...segments);
    assertContained(stagingRoot, destination, `matched dist destination escaped RunContext state: ${row.path}`);
    await makePrivateDirectories(stagingRoot, segments.slice(0, -1));
    await assertPathAbsent(destination, `matched dist destination already exists: ${row.path}`);
    await writeFile(destination, sourceFile.bytes, { flag: "wx", mode: 0o600 });
    await chmod(destination, 0o600);
  }

  const copiedBundle = await scanBundleTree(stagingRoot);
  assert.deepEqual(copiedBundle.files, source.bundleFiles, "matched deploy staging differs from the pinned bundle file table");
  assert.deepEqual(copiedBundle.directories, source.bundleDirectories, "matched deploy staging directory set differs from the pinned bundle");

  const derivedManifest = await buildGatewayMobileWebManifest(stagingRoot, {
    expectedFiles: source.bundleFiles,
  });
  const derivedManifestBytes = Buffer.from(serializeGatewayMobileWebManifest(derivedManifest), "utf8");
  const derivedManifestPath = resolve(stagingRoot, gatewayManifestName);
  await assertPathAbsent(derivedManifestPath, "derived Gateway manifest destination already exists");
  await writeGatewayMobileWebManifest(stagingRoot, derivedManifest);
  await chmod(derivedManifestPath, 0o600);
  const derivedManifestSha256 = sha256(derivedManifestBytes);
  const stagedProof = await inspectOfficialMobileStaticDist({
    distRoot: stagingRoot,
    expectedManifestSha256: derivedManifestSha256,
  });
  assert.equal(stagedProof.resourceCount, expectedBundleFileCount, "derived deploy manifest resource count differs from the matched bundle");
  assert.deepEqual(
    toStaticDistOrder(stagedProof.resources.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }))),
    toStaticDistOrder(source.bundleFiles),
    "derived Gateway manifest resources differ from the matched bundle",
  );

  const owned = await copyOfficialMobileStaticDist(context, {
    distRoot: stagingRoot,
    expectedManifestSha256: derivedManifestSha256,
    outputName,
  });
  assert.equal(owned.ownedCopyVerified, true, "derived deploy-mounted copy must pass the static-dist verifier");
  assert.equal(owned.sourceStableDuringCopy, true, "derived deploy-mounted source must remain stable during copy");
  assert.equal(owned.manifestSha256, derivedManifestSha256, "derived deploy-mounted manifest changed during copy");
  assert.deepEqual(
    toStaticDistOrder(owned.resources.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }))),
    toStaticDistOrder(source.bundleFiles),
    "derived deploy-mounted resources differ from the matched bundle",
  );

  const sourceAfter = await verifyMatchedExportInput({
    bundleRoot,
    exportManifestPath,
    expectedExportManifestSha256,
    expectedBundleSha256,
    expectedSourceTreeSha256,
    expectedDependencySourceTreeSha256,
    expectedDependencyOwnedTreeSha256,
    expectedDependencyFileCount,
    expectedInputRoots,
  });
  assert.deepEqual(sourceAfter.bundleFiles, source.bundleFiles, "matched Mobile Web source changed while materializing the Gateway dist");

  const evidence = {
    status: "passed",
    inputKind: "matched-export-derived-deploy-mount-manifest",
    comparisonId,
    claimBoundary: "matched Mobile Web export bundle adapted to Gateway static-manifest format; not an official Expo RunContext receipt and not a new export",
    sourceExportManifestPath: repoRelative(exportManifestPath),
    sourceExportManifestSha256: source.manifestSha256,
    sourceBundlePath: repoRelative(bundleRoot),
    sourceBundleSha256: source.bundleSha256,
    sourceBundleFileCount: source.bundleFiles.length,
    sourceTreeSha256: source.sourceTreeSha256,
    matchedInputRoots: source.inputRootsAfter,
    dependencyProvenance: {
      sourceTreeSha256: source.dependency.sourceTreeSha256Before,
      sourceUnchanged: source.dependency.sourceUnchanged,
      ownedTreeSha256: source.dependency.copiedTreeSha256,
      ownedFileCount: source.dependency.copiedFileCount,
      copiedSymlinks: source.dependency.copiedSymlinks,
    },
    derivedManifestPath: relative(context.runRoot, derivedManifestPath),
    derivedManifestSha256,
    resourceCount: owned.resourceCount,
    resourceTableSha256: owned.resourceTableSha256,
    ownedCopy: {
      root: relative(context.runRoot, owned.ownedRoot),
      verified: owned.ownedCopyVerified,
      stableDuringCopy: owned.sourceStableDuringCopy,
      directoryMode: owned.ownedDirectoryMode,
      fileMode: owned.ownedFileMode,
    },
    inputRecheckedAfterCopy: true,
  };
  await context.writeArtifactJson(artifactName, evidence);
  return {
    ...owned,
    inputKind: evidence.inputKind,
    comparisonId,
    sourceExportManifestPath: exportManifestPath,
    sourceExportManifestSha256: source.manifestSha256,
    sourceBundlePath: bundleRoot,
    sourceBundleSha256: source.bundleSha256,
    bundleSha256: source.bundleSha256,
    sourceTreeSha256: source.sourceTreeSha256,
    bundleFiles: source.bundleFiles,
    derivedManifestPath,
    manifestArtifactPath: derivedManifestPath,
    matchedEvidence: evidence,
  };
}

/** Read-only validation useful to callers that need provenance before materialization. */
export async function inspectMatchedMobileWebExport(input) {
  return verifyMatchedExportInput(input);
}

async function verifyMatchedExportInput({
  bundleRoot,
  exportManifestPath,
  expectedExportManifestSha256,
  expectedBundleSha256,
  expectedSourceTreeSha256,
  expectedDependencySourceTreeSha256,
  expectedDependencyOwnedTreeSha256,
  expectedDependencyFileCount,
  expectedInputRoots,
}) {
  validatePins({
    expectedExportManifestSha256,
    expectedBundleSha256,
    expectedSourceTreeSha256,
    expectedDependencySourceTreeSha256,
    expectedDependencyOwnedTreeSha256,
    expectedDependencyFileCount,
    expectedInputRoots,
  });
  const normalizedManifestPath = assertNormalizedAbsolutePath(exportManifestPath, "matched export manifest path");
  const normalizedBundleRoot = assertNormalizedAbsolutePath(bundleRoot, "matched bundle root");
  assert.equal(basename(normalizedManifestPath), exportManifestName, "matched export manifest must be named export-manifest.json");
  assert.equal(normalizedBundleRoot, resolve(dirname(normalizedManifestPath), "bundle"), "matched bundle must be the bundle directory paired with its export manifest");
  const manifestBytes = await readRegularNoSymlink(normalizedManifestPath, maximumExportManifestBytes, "matched export manifest");
  const manifestSha256 = sha256(manifestBytes);
  assert.equal(manifestSha256, expectedExportManifestSha256, "matched export manifest SHA-256 changed");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    assert.fail("matched export manifest is not valid JSON");
  }
  assert.ok(manifest && typeof manifest === "object" && !Array.isArray(manifest), "matched export manifest must be an object");
  assert.equal(manifest.schemaVersion, 2, "unsupported matched export manifest schema");
  assert.equal(manifest.status, "complete", "matched export manifest must be complete");
  assert.equal(manifest.failurePhase, null, "matched export must not have a failure phase");
  assert.equal(manifest.sourceUnchanged, true, "matched export source must have stayed stable during export");
  assert.equal(manifest.snapshotUnchangedDuringExport, true, "matched export snapshot must have stayed stable during export");
  assert.equal(manifest.deployMount, true, "matched export must be marked for Gateway deploy mounting");
  assert.equal(manifest.sourceTreeSha256, expectedSourceTreeSha256, "matched source tree SHA-256 changed");
  assert.equal(manifest.bundleSha256, expectedBundleSha256, "matched bundle aggregate SHA-256 changed");
  assert.equal(manifest.bundleFileCount, expectedBundleFileCount, "matched bundle file count changed");

  const dependency = manifest.dependencyProvenance;
  assert.ok(dependency && typeof dependency === "object", "matched export dependency provenance is missing");
  assert.equal(dependency.sourceTreeSha256Before, expectedDependencySourceTreeSha256, "matched dependency input tree SHA-256 changed");
  assert.equal(dependency.sourceTreeSha256After, expectedDependencySourceTreeSha256, "matched dependency input tree changed during export");
  assert.equal(dependency.sourceUnchanged, true, "matched dependency input must have stayed stable during export");
  assert.equal(dependency.copiedTreeSha256, expectedDependencyOwnedTreeSha256, "matched owned dependency tree SHA-256 changed");
  assert.equal(dependency.copiedFileCount, expectedDependencyFileCount, "matched owned dependency file count changed");
  assert.equal(dependency.copiedSymlinks, false, "matched owned dependency tree must not contain symlinks");

  const inputRootsAfter = validateMatchedInputRoots(manifest, expectedInputRoots, expectedSourceTreeSha256);
  const listedFiles = validateBundleFileRows(manifest.bundleFiles, expectedBundleFileCount);
  assert.equal(sha256(Buffer.from(JSON.stringify(listedFiles))), expectedBundleSha256, "matched bundle digest does not match its file table");
  const indexRow = listedFiles.find(row => row.path === "index.html");
  assert.ok(indexRow, "matched bundle must include index.html");
  assert.equal(manifest.indexHtmlSha256, indexRow.sha256, "matched index.html digest differs from the bundle file table");

  const bundleInfo = await lstat(normalizedBundleRoot);
  assert.ok(bundleInfo.isDirectory() && !bundleInfo.isSymbolicLink(), "matched Mobile Web bundle root must be a regular directory");
  assert.equal(await realpath(normalizedBundleRoot), normalizedBundleRoot, "matched Mobile Web bundle root must not traverse a symlink");
  const scanned = await scanBundleTree(normalizedBundleRoot);
  assert.deepEqual(scanned.files, listedFiles, "matched Mobile Web bundle file set or per-file SHA-256 differs from its complete export manifest");
  assert.deepEqual(scanned.directories, expectedDirectories(listedFiles), "matched Mobile Web bundle directory set differs from its complete export manifest");
  assert.equal(sha256(Buffer.from(JSON.stringify(scanned.files))), expectedBundleSha256, "matched Mobile Web bundle aggregate SHA-256 differs from its manifest");

  return {
    inputKind: "matched-mobile-web-export",
    manifestPath: normalizedManifestPath,
    manifestSha256,
    bundleRoot: normalizedBundleRoot,
    bundleSha256: manifest.bundleSha256,
    bundleFiles: scanned.files,
    bundleDirectories: scanned.directories,
    sourceTreeSha256: manifest.sourceTreeSha256,
    inputRootsAfter,
    dependency,
    manifestBytes: manifestBytes.length,
  };
}

function validatePins({
  expectedExportManifestSha256,
  expectedBundleSha256,
  expectedSourceTreeSha256,
  expectedDependencySourceTreeSha256,
  expectedDependencyOwnedTreeSha256,
  expectedDependencyFileCount,
  expectedInputRoots,
}) {
  for (const [name, value] of Object.entries({
    expectedExportManifestSha256,
    expectedBundleSha256,
    expectedSourceTreeSha256,
    expectedDependencySourceTreeSha256,
    expectedDependencyOwnedTreeSha256,
  })) {
    assert.ok(typeof value === "string" && digestPattern.test(value), `${name} must be a 64-character lowercase SHA-256`);
  }
  assert.ok(Number.isSafeInteger(expectedDependencyFileCount) && expectedDependencyFileCount > 0, "expected dependency file count is invalid");
  assert.ok(Array.isArray(expectedInputRoots) && expectedInputRoots.length === 2, "matched input must pin Mobile and Studio Shared source roots");
  const expectedNames = ["mobile", "studio-shared"];
  const expectedDestinations = ["apps/kcoder-studio/mobile", "apps/kcoder-studio/shared"];
  for (const [index, row] of expectedInputRoots.entries()) {
    assert.ok(row && typeof row === "object", `matched input root ${index} is invalid`);
    assert.equal(row.name, expectedNames[index], `matched input root ${index} has an unexpected name`);
    assert.equal(row.destination, expectedDestinations[index], `matched input root ${index} has an unexpected destination`);
    assert.ok(typeof row.sha256 === "string" && digestPattern.test(row.sha256), `matched input root ${index} SHA-256 is invalid`);
    assert.ok(Number.isSafeInteger(row.fileCount) && row.fileCount > 0, `matched input root ${index} file count is invalid`);
  }
}

function validateMatchedInputRoots(manifest, expectedInputRoots, expectedSourceTreeSha256) {
  assert.ok(Array.isArray(manifest.inputRoots) && Array.isArray(manifest.inputRootsAfter), "matched export input-root records are missing");
  const projectRoots = roots => roots.map(root => ({
    name: root?.name,
    destination: root?.destination,
    sha256: root?.sha256,
    fileCount: root?.fileCount,
  }));
  const before = projectRoots(manifest.inputRoots);
  const after = projectRoots(manifest.inputRootsAfter);
  assert.deepEqual(before, expectedInputRoots, "matched export initial source roots differ from pinned input roots");
  assert.deepEqual(after, expectedInputRoots, "matched export terminal source roots differ from pinned input roots");
  const aggregate = sha256(Buffer.from(JSON.stringify(after.map(({ name, destination, sha256: digest }) => ({ name, destination, sha256: digest })))));
  assert.equal(aggregate, expectedSourceTreeSha256, "matched source root aggregate digest differs from the pinned source tree");
  return after;
}

function validateBundleFileRows(rows, expectedCount) {
  assert.ok(Array.isArray(rows), "matched export bundle file table is missing");
  assert.equal(rows.length, expectedCount, "matched export bundle file count changed");
  let totalBytes = 0;
  const paths = new Set();
  const normalized = rows.map((row, index) => {
    assert.ok(row && typeof row === "object" && !Array.isArray(row), `matched bundle row ${index} is invalid`);
    assert.deepEqual(Object.keys(row).sort(), ["path", "sha256", "size"], `matched bundle row ${index} has unexpected fields`);
    safeBundlePath(row.path);
    assert.ok(!paths.has(row.path), `matched bundle contains duplicate path: ${row.path}`);
    paths.add(row.path);
    assert.ok(Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= maximumBundleFileBytes, `matched bundle resource size is invalid: ${row.path}`);
    assert.ok(typeof row.sha256 === "string" && digestPattern.test(row.sha256), `matched bundle resource SHA-256 is invalid: ${row.path}`);
    totalBytes += row.size;
    assert.ok(totalBytes <= maximumBundleBytes, "matched Mobile Web bundle exceeds the total-size bound");
    return { path: row.path, size: row.size, sha256: row.sha256 };
  }).sort((left, right) => left.path.localeCompare(right.path));
  assert.ok(normalized.some(row => row.path === "index.html"), "matched bundle must include index.html");
  return normalized;
}

async function scanBundleTree(root) {
  const files = [];
  const directories = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = resolve(directory, entry.name);
      const info = await lstat(absolute);
      assert.equal(info.isSymbolicLink(), false, `matched Mobile Web bundle contains a symlink: ${path}`);
      if (info.isDirectory()) {
        directories.push(path);
        assert.equal(await realpath(absolute), absolute, `matched Mobile Web bundle directory traverses a symlink: ${path}`);
        await visit(absolute, path);
        continue;
      }
      assert.ok(info.isFile(), `matched Mobile Web bundle contains a special file: ${path}`);
      const segments = safeBundlePath(path);
      assertContained(root, absolute, `matched Mobile Web bundle resource escaped its root: ${path}`);
      assert.ok(info.size <= maximumBundleFileBytes, `matched Mobile Web bundle resource exceeds the size limit: ${path}`);
      const bytes = await readRegularNoSymlink(absolute, maximumBundleFileBytes, `matched Mobile Web bundle resource ${path}`);
      assert.equal(bytes.length, info.size, `matched Mobile Web bundle resource changed while reading: ${path}`);
      files.push({ path: segments.join("/"), size: bytes.length, sha256: sha256(bytes) });
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort((left, right) => left.localeCompare(right));
  return { files, directories };
}

async function readMatchedBundleFile(root, segments, expected) {
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const info = await lstat(current);
    assert.equal(info.isSymbolicLink(), false, `matched Mobile Web bundle contains a symlink: ${expected.path}`);
    if (index < segments.length - 1) {
      assert.ok(info.isDirectory(), `matched Mobile Web bundle resource parent is not a directory: ${expected.path}`);
      assert.equal(await realpath(current), current, `matched Mobile Web bundle resource parent traverses a symlink: ${expected.path}`);
    } else {
      assert.ok(info.isFile(), `matched Mobile Web bundle resource is not a regular file: ${expected.path}`);
      assert.equal(info.size, expected.size, `matched Mobile Web bundle resource size changed: ${expected.path}`);
      assert.ok(info.size <= maximumBundleFileBytes, `matched Mobile Web bundle resource exceeds the size limit: ${expected.path}`);
    }
  }
  assert.equal(await realpath(current), current, `matched Mobile Web bundle resource traverses a symlink: ${expected.path}`);
  const bytes = await readRegularNoSymlink(current, maximumBundleFileBytes, `matched Mobile Web bundle resource ${expected.path}`);
  assert.equal(bytes.length, expected.size, `matched Mobile Web bundle resource size changed while reading: ${expected.path}`);
  assert.equal(sha256(bytes), expected.sha256, `matched Mobile Web bundle resource SHA-256 changed: ${expected.path}`);
  return { bytes };
}

function expectedDirectories(rows) {
  const directories = new Set();
  for (const row of rows) {
    const segments = row.path.split("/");
    for (let index = 1; index < segments.length; index += 1) directories.add(segments.slice(0, index).join("/"));
  }
  return [...directories].sort((left, right) => left.localeCompare(right));
}

function toStaticDistOrder(rows) {
  return [...rows].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function safeBundlePath(value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 1024, "matched bundle path is invalid");
  assert.ok(!value.includes("\\") && !value.includes("\0"), "matched bundle path must use safe POSIX separators");
  assert.ok(!isAbsolute(value) && !win32.isAbsolute(value), "matched bundle path must be relative");
  assert.ok(!/[\%?#\x00-\x1f\x7f]/.test(value), "matched bundle path contains unsupported characters");
  const segments = value.split("/");
  assert.ok(segments.every(segment => segment && segment !== "." && segment !== ".."), "matched bundle path contains an unsafe segment");
  assert.notEqual(value, gatewayManifestName, "matched bundle path conflicts with Gateway's derived manifest");
  return segments;
}

async function validateRunContextPaths(context, stagingName, outputName) {
  const runRoot = assertNormalizedAbsolutePath(context.runRoot, "RunContext root");
  const stateDir = assertNormalizedAbsolutePath(context.stateDir, "RunContext state directory");
  assertContained(runRoot, stateDir, "RunContext state directory must remain inside its run root");
  assert.notEqual(stateDir, runRoot, "RunContext state directory cannot be the run root");
  const runInfo = await lstat(runRoot);
  const stateInfo = await lstat(stateDir);
  assert.ok(runInfo.isDirectory() && !runInfo.isSymbolicLink(), "RunContext root must be a real directory");
  assert.ok(stateInfo.isDirectory() && !stateInfo.isSymbolicLink(), "RunContext state must be a real directory");
  assert.equal(await realpath(runRoot), runRoot, "RunContext root must not traverse a symlink");
  assert.equal(await realpath(stateDir), stateDir, "RunContext state must not traverse a symlink");
  assert.equal(stateInfo.mode & 0o777, 0o700, "RunContext state must have private directory permissions");
  if (typeof process.getuid === "function") assert.equal(stateInfo.uid, process.getuid(), "RunContext state must be owned by the current user");
  const stagingRoot = assertNormalizedAbsolutePath(context.pathInState(stagingName), "RunContext matched staging path");
  const ownedRoot = assertNormalizedAbsolutePath(context.pathInState(outputName), "RunContext matched output path");
  assertContained(stateDir, stagingRoot, "matched dist staging must remain inside this RunContext state");
  assertContained(stateDir, ownedRoot, "matched dist output must remain inside this RunContext state");
  assert.notEqual(stagingRoot, ownedRoot, "matched dist staging and output paths must differ");
  return { runRoot, stateDir, stagingRoot, ownedRoot };
}

async function assertPathAbsent(path, message) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.fail(message);
}

async function makePrivateDirectories(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    assertContained(root, current, "matched staging directory escaped RunContext state");
    try {
      await mkdir(current, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), "matched staging parent must be a private directory");
    assert.equal(await realpath(current), current, "matched staging parent must not traverse a symlink");
    await chmod(current, 0o700);
  }
}

async function readRegularNoSymlink(path, maximumBytes, label) {
  const normalized = assertNormalizedAbsolutePath(path, label);
  const info = await lstat(normalized);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  assert.ok(info.size <= maximumBytes, `${label} exceeds its size bound`);
  assert.equal(await realpath(normalized), normalized, `${label} must not traverse a symlink`);
  const bytes = await readFile(normalized);
  assert.ok(bytes.length <= maximumBytes, `${label} exceeds its size bound while reading`);
  assert.equal(bytes.length, info.size, `${label} changed while reading`);
  return bytes;
}

function assertNormalizedAbsolutePath(value, label) {
  assert.ok(typeof value === "string" && isAbsolute(value), `${label} must be absolute`);
  assert.equal(resolve(value), value, `${label} must be normalized`);
  return value;
}

function repoRelative(path) {
  const normalized = assertNormalizedAbsolutePath(path, "evidence source path");
  const pathFromRepo = relative(repoRoot, normalized);
  if (pathFromRepo === ".." || pathFromRepo.startsWith(`..${sep}`) || isAbsolute(pathFromRepo)) return null;
  return pathFromRepo.split(sep).join("/");
}

function assertContained(root, candidate, message) {
  const path = relative(root, candidate);
  assert.ok(path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`), message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
