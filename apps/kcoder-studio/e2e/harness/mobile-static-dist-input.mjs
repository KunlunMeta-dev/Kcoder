import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

const manifestName = "kcoder-mobile-web.json";
const expectedBaseToken = "/__kcoder_mobile_mount_v1__";
const expectedResourceCount = 37;
const maximumManifestBytes = 1024 * 1024;
const maximumTotalBytes = 64 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;

/**
 * Inspect the official Mobile Web static-dist manifest without treating it as
 * an Expo RunContext export manifest or inventing builder provenance.
 */
export async function inspectOfficialMobileStaticDist({ distRoot, expectedManifestSha256 }) {
  assert.ok(typeof distRoot === "string" && isAbsolute(distRoot), "Mobile static dist root must be absolute");
  assert.equal(resolve(distRoot), distRoot, "Mobile static dist root must be normalized");
  assert.ok(digestPattern.test(expectedManifestSha256), "expected official dist manifest SHA-256 is invalid");

  const rootInfo = await lstat(distRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "Mobile static dist root must be a real directory");
  assert.equal(await realpath(distRoot), distRoot, "Mobile static dist root must not traverse a symlink");

  const manifestPath = join(distRoot, manifestName);
  const manifestInfo = await assertRegularNoSymlink(distRoot, manifestPath);
  assert.ok(manifestInfo.size <= maximumManifestBytes, "official Mobile dist manifest exceeds the size bound");
  const manifestBytes = await readFile(manifestPath);
  assert.ok(manifestBytes.length <= maximumManifestBytes, "official Mobile dist manifest exceeds the size bound");
  const manifestSha256 = sha256(manifestBytes);
  assert.equal(manifestSha256, expectedManifestSha256, "official Mobile dist manifest SHA-256 changed");

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    assert.fail("official Mobile dist manifest is not valid JSON");
  }
  assert.ok(manifest && typeof manifest === "object" && !Array.isArray(manifest), "official Mobile dist manifest must be an object");
  assert.deepEqual(Object.keys(manifest).sort(), ["baseToken", "files", "version"], "unexpected official Mobile dist manifest fields");
  assert.equal(manifest.version, 1, "unsupported official Mobile dist manifest version");
  assert.equal(manifest.baseToken, expectedBaseToken, "unexpected official Mobile dist base token");
  assert.ok(Array.isArray(manifest.files), "official Mobile dist files must be an array");
  assert.equal(manifest.files.length, expectedResourceCount, "official Mobile dist resource count changed");

  const resources = [];
  const resourcePaths = new Set();
  let totalBytes = 0;
  for (const [index, row] of manifest.files.entries()) {
    assert.ok(row && typeof row === "object" && !Array.isArray(row), `resource ${index} must be an object`);
    assert.deepEqual(Object.keys(row).sort(), ["path", "replacements", "sha256", "size", "text"], `resource ${index} has unexpected fields`);
    const pathParts = safeResourcePath(row.path);
    assert.ok(!resourcePaths.has(row.path), `duplicate official Mobile dist resource path: ${row.path}`);
    resourcePaths.add(row.path);
    assert.ok(Number.isSafeInteger(row.size) && row.size >= 0, `invalid resource size for ${row.path}`);
    assert.ok(digestPattern.test(row.sha256), `invalid resource SHA-256 for ${row.path}`);
    assert.equal(typeof row.text, "boolean", `invalid text flag for ${row.path}`);
    assert.ok(Number.isSafeInteger(row.replacements) && row.replacements >= 0, `invalid replacement count for ${row.path}`);
    totalBytes += row.size;
    assert.ok(totalBytes <= maximumTotalBytes, "official Mobile dist exceeds the total-size bound");

    const filePath = resolve(distRoot, ...pathParts);
    assertContained(distRoot, filePath, `resource path escaped the official Mobile dist: ${row.path}`);
    const fileInfo = await assertRegularNoSymlink(distRoot, filePath);
    assert.ok(fileInfo.size <= maximumTotalBytes, `official Mobile dist resource exceeds the size bound: ${row.path}`);
    assert.equal(fileInfo.size, row.size, `resource size changed: ${row.path}`);
    const bytes = await readFile(filePath);
    assert.equal(bytes.length, row.size, `resource size changed: ${row.path}`);
    assert.equal(sha256(bytes), row.sha256, `resource SHA-256 changed: ${row.path}`);
    resources.push({ path: row.path, size: row.size, sha256: row.sha256, text: row.text, replacements: row.replacements });
  }

  const expectedDirectories = new Set();
  for (const path of resourcePaths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1)
      expectedDirectories.add(segments.slice(0, index).join("/"));
  }
  const actualTree = await scanTree(distRoot);
  const expectedFiles = [...resourcePaths, manifestName].sort(compareText);
  assert.deepEqual(actualTree.files.sort(compareText), expectedFiles, "official Mobile dist file set differs from its manifest");
  assert.deepEqual(actualTree.directories.sort(compareText), [...expectedDirectories].sort(compareText), "official Mobile dist contains an unlisted or missing directory");

  const sortedResources = [...resources].sort((left, right) => compareText(left.path, right.path));
  return {
    inputKind: "official-mobile-static-dist",
    distRoot,
    manifestPath,
    manifestSha256,
    manifestSize: manifestBytes.length,
    version: manifest.version,
    baseToken: manifest.baseToken,
    resourceCount: resources.length,
    totalResourceBytes: totalBytes,
    resourceTableSha256: sha256(Buffer.from(JSON.stringify(sortedResources))),
    resources: sortedResources,
  };
}

/** Copy a validated official dist into this run's owned state directory. */
export async function copyOfficialMobileStaticDist(context, {
  distRoot,
  expectedManifestSha256,
  outputName = "official-mobile-static-dist",
}) {
  assert.ok(context && typeof context.pathInState === "function", "a RunContext is required");
  assert.ok(typeof context.registerTemporaryDirectory === "function", "RunContext temporary-directory registration is required");
  assert.match(outputName, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/, "owned Mobile dist name is invalid");

  const sourceBefore = await inspectOfficialMobileStaticDist({ distRoot, expectedManifestSha256 });
  const stateDir = resolve(context.stateDir);
  const ownedRoot = context.pathInState(outputName);
  assert.equal(resolve(ownedRoot), ownedRoot, "RunContext returned a non-normalized Mobile dist path");
  assertContained(stateDir, ownedRoot, "owned Mobile dist must be inside this RunContext state");
  assert.notEqual(ownedRoot, stateDir, "owned Mobile dist cannot be the RunContext state root");
  assert.equal(await realpath(stateDir), stateDir, "RunContext state root must not traverse a symlink");
  await assertPathAbsent(ownedRoot);

  await mkdir(ownedRoot, { recursive: false, mode: 0o700 });
  await chmod(ownedRoot, 0o700);
  context.registerTemporaryDirectory("official Mobile static dist input copy", ownedRoot);

  const sourceManifestInfo = await assertRegularNoSymlink(distRoot, sourceBefore.manifestPath);
  assert.ok(sourceManifestInfo.size <= maximumManifestBytes, "official Mobile dist manifest exceeds the size bound before copy");
  assert.equal(sourceManifestInfo.size, sourceBefore.manifestSize, "official Mobile dist manifest size changed before copy");
  const manifestBytes = await readFile(sourceBefore.manifestPath);
  assert.ok(manifestBytes.length <= maximumManifestBytes, "official Mobile dist manifest exceeds the size bound during copy");
  assert.equal(sha256(manifestBytes), sourceBefore.manifestSha256, "official dist manifest changed before copy");
  for (const resource of sourceBefore.resources) {
    const pathParts = safeResourcePath(resource.path);
    const sourcePath = resolve(distRoot, ...pathParts);
    const destinationPath = resolve(ownedRoot, ...pathParts);
    assertContained(ownedRoot, destinationPath, `owned resource path escaped RunContext state: ${resource.path}`);
    await makeOwnedDirectories(ownedRoot, pathParts.slice(0, -1));
    await assertPathAbsent(destinationPath);
    const sourceInfo = await assertRegularNoSymlink(distRoot, sourcePath);
    assert.ok(sourceInfo.size <= maximumTotalBytes, `official Mobile dist resource exceeds the size bound before copy: ${resource.path}`);
    assert.equal(sourceInfo.size, resource.size, `source resource size changed before copy: ${resource.path}`);
    const bytes = await readFile(sourcePath);
    assert.ok(bytes.length <= maximumTotalBytes, `official Mobile dist resource exceeds the size bound during copy: ${resource.path}`);
    assert.equal(bytes.length, resource.size, `source resource size changed during copy: ${resource.path}`);
    assert.equal(sha256(bytes), resource.sha256, `source resource changed during copy: ${resource.path}`);
    await writeFile(destinationPath, bytes, { flag: "wx", mode: 0o600 });
    await chmod(destinationPath, 0o600);
  }
  const ownedManifestPath = join(ownedRoot, manifestName);
  await writeFile(ownedManifestPath, manifestBytes, { flag: "wx", mode: 0o600 });
  await chmod(ownedManifestPath, 0o600);

  const owned = await inspectOfficialMobileStaticDist({ distRoot: ownedRoot, expectedManifestSha256 });
  await assertOwnedModes(ownedRoot);
  const sourceAfter = await inspectOfficialMobileStaticDist({ distRoot, expectedManifestSha256 });
  assert.deepEqual(sourceAfter.resources, sourceBefore.resources, "official Mobile dist resource inventory changed during copy");
  assert.equal(sourceAfter.resourceTableSha256, sourceBefore.resourceTableSha256, "official Mobile dist resource table changed during copy");
  assert.deepEqual(owned.resources, sourceBefore.resources, "owned Mobile dist copy differs from the official resources");
  assert.equal(owned.manifestSha256, sourceBefore.manifestSha256, "owned Mobile dist manifest differs from the official manifest");

  return {
    ...sourceBefore,
    ownedRoot,
    ownedManifestPath,
    ownedDirectoryMode: "0700",
    ownedFileMode: "0600",
    sourceStableDuringCopy: true,
    ownedCopyVerified: true,
  };
}

function safeResourcePath(value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 1024, "resource path is invalid");
  assert.ok(!value.includes("\\") && !value.includes("\0"), "resource path must use safe POSIX separators");
  assert.ok(!isAbsolute(value) && !win32.isAbsolute(value), "resource path must be relative");
  const segments = value.split("/");
  assert.ok(segments.every(segment => segment && segment !== "." && segment !== ".."), "resource path contains an unsafe segment");
  assert.notEqual(value, manifestName, "resource path conflicts with the official manifest");
  return segments;
}

async function assertRegularNoSymlink(root, path) {
  assertContained(root, path, "Mobile dist path escaped its root");
  const segments = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const info = await lstat(current);
    assert.equal(info.isSymbolicLink(), false, `Mobile dist contains a symlink: ${relative(root, current)}`);
    if (index < segments.length - 1)
      assert.ok(info.isDirectory(), `Mobile dist parent is not a directory: ${relative(root, current)}`);
    else assert.ok(info.isFile(), `Mobile dist resource is not a regular file: ${relative(root, current)}`);
    if (index === segments.length - 1) return info;
  }
}

async function scanTree(root, relativeRoot = "", result = { files: [], directories: [] }) {
  for (const entry of await readdir(resolve(root, relativeRoot), { withFileTypes: true })) {
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const absolutePath = resolve(root, relativePath);
    const info = await lstat(absolutePath);
    assert.equal(info.isSymbolicLink(), false, `Mobile dist contains a symlink: ${relativePath}`);
    if (info.isDirectory()) {
      result.directories.push(relativePath);
      await scanTree(root, relativePath, result);
    } else if (info.isFile()) result.files.push(relativePath);
    else assert.fail(`Mobile dist contains a special file: ${relativePath}`);
  }
  return result;
}

async function makeOwnedDirectories(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), "owned Mobile dist parent must be a real directory");
    await chmod(current, 0o700);
  }
}

async function assertOwnedModes(root, relativeRoot = "") {
  const directory = resolve(root, relativeRoot);
  const info = await lstat(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), "owned Mobile dist directory must be real");
  assert.equal(info.mode & 0o777, 0o700, `owned Mobile dist directory mode differs: ${relativeRoot || "."}`);
  if (typeof process.getuid === "function") assert.equal(info.uid, process.getuid(), "owned Mobile dist directory has the wrong owner");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const child = resolve(root, path);
    const childInfo = await lstat(child);
    assert.equal(childInfo.isSymbolicLink(), false, `owned Mobile dist contains a symlink: ${path}`);
    if (childInfo.isDirectory()) await assertOwnedModes(root, path);
    else {
      assert.ok(childInfo.isFile(), `owned Mobile dist contains a special file: ${path}`);
      assert.equal(childInfo.mode & 0o777, 0o600, `owned Mobile dist file mode differs: ${path}`);
      if (typeof process.getuid === "function") assert.equal(childInfo.uid, process.getuid(), `owned Mobile dist file has the wrong owner: ${path}`);
    }
  }
}

async function assertPathAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.fail(`owned Mobile dist destination already exists: ${path}`);
}

function assertContained(root, path, message) {
  const relativePath = relative(root, path);
  assert.ok(relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath), message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
