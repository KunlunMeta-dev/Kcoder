import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import {
  buildGatewayMobileWebManifest,
  serializeGatewayMobileWebManifest,
  writeGatewayMobileWebManifest,
} from "../../mobile/scripts/gateway-mobile-web-manifest.mjs";

const manifestName = "kcoder-mobile-web.json";
const sha256Pattern = /^[a-f0-9]{64}$/;

/**
 * Copy a caller-pinned archived Expo bundle into an independent RunContext-owned
 * Gateway deployment tree and generate the production static-handler manifest.
 */
export async function materializeArchivedMobileWebDeployment(context, {
  mobileWeb,
  sourcePins,
  outputName = "mobile-web-archived-deployment",
} = {}) {
  assertRunContext(context);
  assertSlug(outputName, "deployment directory");
  const input = validateArchivedMobileWebInput(mobileWeb, sourcePins);
  const stateRoot = resolve(context.stateDir);
  assert.equal(await realpath(stateRoot), stateRoot, "RunContext state root must not traverse a symlink");
  const deploymentRoot = resolve(context.pathInState(outputName));
  assertContained(stateRoot, deploymentRoot, "derived Mobile deployment escaped RunContext state");
  await assertPathAbsent(deploymentRoot, "derived Mobile deployment destination already exists");
  await mkdir(deploymentRoot, { recursive: false, mode: 0o700 });
  await chmod(deploymentRoot, 0o700);
  try {
    context.registerTemporaryDirectory("derived archived Mobile Gateway deployment", deploymentRoot);
  } catch (error) {
    await rm(deploymentRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  try {
    const expectedFiles = input.bundleFiles;
    for (const row of expectedFiles) {
      const segments = safeResourcePath(row.path);
      const bytes = await readVerifiedArchivedResource(input.bundleRoot, segments, row);
      const destination = resolve(deploymentRoot, ...segments);
      assertContained(deploymentRoot, destination, `derived Mobile resource escaped its deployment root: ${row.path}`);
      await makePrivateDirectories(deploymentRoot, segments.slice(0, -1));
      await assertPathAbsent(destination, `derived Mobile resource destination already exists: ${row.path}`);
      const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o400);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(destination, 0o400);
    }

    const derivedManifest = await buildGatewayMobileWebManifest(deploymentRoot, { expectedFiles });
    const serializedManifest = serializeGatewayMobileWebManifest(derivedManifest);
    await writeGatewayMobileWebManifest(deploymentRoot, derivedManifest);
    const manifestPath = resolve(deploymentRoot, manifestName);
    const manifestBytes = await readFile(manifestPath);
    assert.equal(manifestBytes.toString("utf8"), serializedManifest,
      "production Mobile manifest writer output differs from its serializer");
    await chmod(manifestPath, 0o400);

    const postWriteManifest = await buildGatewayMobileWebManifest(deploymentRoot, { expectedFiles });
    assert.deepEqual(postWriteManifest, derivedManifest,
      "derived Mobile resource inventory changed after the production manifest was written");
    const physicalFiles = await scanPhysicalFiles(deploymentRoot);
    const expectedPhysicalFiles = [...expectedFiles.map(row => row.path), manifestName].sort(comparePath);
    assert.deepEqual(physicalFiles, expectedPhysicalFiles,
      "derived Mobile deployment physical file set differs from the exact resource inventory plus manifest");
    assert.equal(physicalFiles.length, expectedFiles.length + 1,
      "derived Mobile deployment must contain every resource and exactly one manifest");

    return {
      path: deploymentRoot,
      manifestPath,
      manifestSha256: sha256(manifestBytes),
      originalBundleSha256: input.bundleSha256,
      sourcePins: input.sourcePins,
      resourceCount: derivedManifest.files.length,
      physicalFileCount: physicalFiles.length,
      manifestFiles: derivedManifest.files,
      physicalFiles,
      inventoryVerifiedAgainstArchive: true,
      productionManifestBuilder: "buildGatewayMobileWebManifest",
      productionManifestSerializer: "serializeGatewayMobileWebManifest",
      productionManifestWriter: "writeGatewayMobileWebManifest",
    };
  } catch (error) {
    await rm(deploymentRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function validateArchivedMobileWebInput(mobileWeb, sourcePins) {
  assert.ok(mobileWeb && typeof mobileWeb === "object", "verified archived Mobile Web input is required");
  assert.equal(mobileWeb.inputKind, "verified-readonly-data-archive",
    "derived deployment requires a restored caller-pinned data archive");
  assert.ok(typeof mobileWeb.path === "string" && isAbsolute(mobileWeb.path),
    "restored Mobile Web bundle root must be absolute");
  assert.equal(resolve(mobileWeb.path), mobileWeb.path, "restored Mobile Web bundle root must be normalized");
  assert.ok(Array.isArray(mobileWeb.bundleFiles) && mobileWeb.bundleFiles.length > 0,
    "restored Mobile Web bundle resource table is missing");
  assert.match(mobileWeb.bundleSha256 ?? "", sha256Pattern, "restored Mobile Web bundle SHA-256 is invalid");
  assert.match(mobileWeb.archiveSha256 ?? "", sha256Pattern, "restored Mobile Web archive SHA-256 is invalid");
  assert.match(mobileWeb.originalManifestSha256 ?? "", sha256Pattern,
    "restored original export manifest SHA-256 is invalid");
  assert.ok(sourcePins && typeof sourcePins === "object", "caller source and archive pins are required");
  assert.equal(resolve(sourcePins.archivePath ?? ""), resolve(mobileWeb.archivePath ?? ""),
    "derived deployment archive path differs from the restored archive");
  assert.equal(sourcePins.archiveSha256, mobileWeb.archiveSha256,
    "derived deployment archive SHA-256 differs from the restored archive pin");
  assert.equal(sourcePins.originalManifestSha256, mobileWeb.originalManifestSha256,
    "derived deployment original manifest SHA-256 differs from the restored export");
  assert.equal(resolve(sourcePins.sourceRoot ?? ""), resolve(mobileWeb.sourceRoot ?? ""),
    "derived deployment source root differs from the restored source identity");
  assert.match(sourcePins.sourceManifestSha256 ?? "", sha256Pattern,
    "caller-pinned Mobile source manifest SHA-256 is invalid");
  assert.ok(typeof sourcePins.sourceManifestPath === "string" && isAbsolute(sourcePins.sourceManifestPath),
    "caller-pinned Mobile source manifest path must be absolute");
  assert.ok(sourcePins.sourceSnapshotProof && typeof sourcePins.sourceSnapshotProof === "object",
    "caller-pinned Mobile source snapshot proof is required");
  assert.equal(resolve(sourcePins.sourceSnapshotProof.manifestPath ?? ""), resolve(sourcePins.sourceManifestPath),
    "Mobile source snapshot proof identifies a different manifest path");
  assert.equal(sourcePins.sourceSnapshotProof.manifestSha256, sourcePins.sourceManifestSha256,
    "Mobile source snapshot proof differs from its caller SHA-256 pin");
  assert.equal(sourcePins.sourceTreeSha256, mobileWeb.sourceTreeSha256,
    "derived deployment source tree SHA-256 differs from the restored source identity");
  assert.ok(Array.isArray(mobileWeb.sourceRoots) && mobileWeb.sourceRoots.length === 2,
    "restored Mobile and shared source roots are required");
  const sourceRoots = mobileWeb.sourceRoots.map(root => ({
    name: root.name,
    destination: root.destination,
    sha256: root.sha256,
    fileCount: root.fileCount,
  }));
  assert.ok(sourceRoots.every(root => sha256Pattern.test(root.sha256) && Number.isSafeInteger(root.fileCount) && root.fileCount > 0),
    "restored Mobile source root pins are invalid");

  const bundleFiles = mobileWeb.bundleFiles.map(row => {
    assert.ok(row && typeof row === "object", "restored Mobile resource row is invalid");
    safeResourcePath(row.path);
    assert.ok(Number.isSafeInteger(row.size) && row.size >= 0, `restored Mobile resource size is invalid: ${row.path}`);
    assert.match(row.sha256 ?? "", sha256Pattern, `restored Mobile resource SHA-256 is invalid: ${row.path}`);
    return { path: row.path, size: row.size, sha256: row.sha256 };
  }).sort((left, right) => comparePath(left.path, right.path));
  assert.equal(new Set(bundleFiles.map(row => row.path)).size, bundleFiles.length,
    "restored Mobile resource table contains duplicate paths");
  assert.equal(bundleFiles.some(row => row.path === manifestName), false,
    "data-only archive unexpectedly contains the derived Gateway manifest");
  assert.equal(sha256(Buffer.from(JSON.stringify(bundleFiles))), mobileWeb.bundleSha256,
    "restored Mobile resource table differs from the original bundle SHA-256");

  return {
    bundleRoot: mobileWeb.path,
    bundleFiles,
    bundleSha256: mobileWeb.bundleSha256,
    sourcePins: {
      archivePath: resolve(sourcePins.archivePath),
      archiveSha256: sourcePins.archiveSha256,
      originalManifestSha256: sourcePins.originalManifestSha256,
      sourceRoot: resolve(sourcePins.sourceRoot),
      sourceManifestPath: resolve(sourcePins.sourceManifestPath),
      sourceManifestSha256: sourcePins.sourceManifestSha256,
      sourceTreeSha256: sourcePins.sourceTreeSha256,
      sourceSnapshotProof: sourcePins.sourceSnapshotProof,
      sourceRoots,
      dependencySourceTreeSha256: mobileWeb.origin?.dependencySourceTreeSha256 ?? null,
      dependencyOwnedTreeSha256: mobileWeb.origin?.dependencyOwnedTreeSha256 ?? null,
      dependencyProvenanceIsHistorical: mobileWeb.dependencyProvenanceIsHistorical === true,
    },
  };
}

async function readVerifiedArchivedResource(root, segments, row) {
  const normalizedRoot = resolve(root);
  assert.equal(await realpath(normalizedRoot), normalizedRoot, "restored Mobile Web source root must not traverse a symlink");
  const rootInfo = await lstat(normalizedRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "restored Mobile Web source root must be a real directory");
  let sourcePath = normalizedRoot;
  for (const [index, segment] of segments.entries()) {
    sourcePath = join(sourcePath, segment);
    const info = await lstat(sourcePath);
    assert.equal(info.isSymbolicLink(), false, `restored Mobile resource path contains a symlink: ${row.path}`);
    if (index < segments.length - 1) {
      assert.ok(info.isDirectory(), `restored Mobile resource parent is not a directory: ${row.path}`);
    } else {
      assert.ok(info.isFile(), `restored Mobile resource is not a regular file: ${row.path}`);
      assert.equal(info.size, row.size, `restored Mobile resource size changed: ${row.path}`);
    }
  }
  const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    assert.ok(info.isFile(), `restored Mobile resource is not a regular file: ${row.path}`);
    assert.equal(info.size, row.size, `restored Mobile resource size changed while opening: ${row.path}`);
    const bytes = await handle.readFile();
    assert.equal(bytes.length, row.size, `restored Mobile resource size changed while reading: ${row.path}`);
    assert.equal(sha256(bytes), row.sha256, `restored Mobile resource SHA-256 changed: ${row.path}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function safeResourcePath(value) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 1024,
    "Mobile resource path is invalid");
  assert.ok(!value.includes("\\") && !/[\0-\x1f\x7f%?#]/.test(value),
    "Mobile resource path contains an unsupported character");
  assert.ok(!isAbsolute(value) && !win32.isAbsolute(value), "Mobile resource path must be relative");
  const segments = value.split("/");
  assert.ok(segments.every(segment => segment && segment !== "." && segment !== ".."),
    "Mobile resource path contains an unsafe segment");
  assert.ok(segments.every(segment => !segment.startsWith(".") || value === "_expo/.routes.json"),
    "Mobile resource path contains an unsupported hidden entry");
  return segments;
}

async function makePrivateDirectories(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), "derived Mobile deployment parent must be a real directory");
    await chmod(current, 0o700);
  }
}

async function scanPhysicalFiles(root, relativeRoot = "", files = []) {
  for (const entry of await readdir(resolve(root, relativeRoot), { withFileTypes: true })) {
    const path = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const absolutePath = resolve(root, path);
    const info = await lstat(absolutePath);
    assert.equal(info.isSymbolicLink(), false, `derived Mobile deployment contains a symlink: ${path}`);
    if (info.isDirectory()) await scanPhysicalFiles(root, path, files);
    else {
      assert.ok(info.isFile(), `derived Mobile deployment contains a special file: ${path}`);
      files.push(path);
    }
  }
  return files.sort(comparePath);
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

function assertRunContext(context) {
  assert.ok(context && typeof context === "object", "RunContext is required");
  assert.ok(typeof context.stateDir === "string" && isAbsolute(context.stateDir), "RunContext state directory is required");
  assert.ok(typeof context.pathInState === "function", "RunContext state path resolver is required");
  assert.ok(typeof context.registerTemporaryDirectory === "function", "RunContext temporary-directory ownership is required");
}

function assertSlug(value, label) {
  assert.ok(typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value), `${label} is invalid`);
}

function assertContained(root, path, message) {
  const pathRelative = relative(root, path);
  assert.ok(pathRelative && pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative), message);
}

function comparePath(left, right) {
  return left.localeCompare(right);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
