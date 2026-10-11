import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { repoRoot } from "./run-context.mjs";

const artifactBoundary = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e");
const defaultExpectedBundleFileCount = 37;
const maximumManifestBytes = 1024 * 1024;
const maximumBundleBytes = 64 * 1024 * 1024;
const fileReadChunkBytes = 64 * 1024;
const expectedSourceManifestKeys = new Set([
  "schemaVersion",
  "purpose",
  "sourceCommit",
  "sourceTreeSha256",
  "bundleSha256",
  "bundleFileCount",
  "indexHtmlSha256",
  "directory",
  "files",
]);

/**
 * Reuse a retained, verified public Mobile Web export in this RunContext.
 * This copies only manifest-listed public bundle files; it never invokes Expo.
 */
export async function reuseMobileWebExport(
  context,
  {
    bundleRoot,
    manifestPath,
    expectedSourceTreeSha256,
    expectedManifestSha256,
    expectedBundleSha256,
    expectedBundleFileCount = defaultExpectedBundleFileCount,
    label,
    outputName,
  },
) {
  assert.ok(context && typeof context.pathInState === "function", "a RunContext is required");
  assertSafeSlug(label, "reuse label");
  assertSafeSlug(outputName, "owned output name");
  assert.ok(isAbsolute(bundleRoot), "bundleRoot must be an absolute path");
  assert.ok(isAbsolute(manifestPath), "manifestPath must be an absolute path");
  assert.ok(/^[a-f0-9]{64}$/.test(expectedSourceTreeSha256), "expected source tree SHA-256 is invalid");
  assert.ok(expectedManifestSha256 === undefined || /^[a-f0-9]{64}$/.test(expectedManifestSha256), "expected manifest SHA-256 is invalid");
  assert.ok(expectedBundleSha256 === undefined || /^[a-f0-9]{64}$/.test(expectedBundleSha256), "expected bundle SHA-256 is invalid");
  assert.ok(Number.isSafeInteger(expectedBundleFileCount) && expectedBundleFileCount > 0, "expected bundle file count must be a positive safe integer");
  assert.ok(resolve(bundleRoot) === bundleRoot, "bundleRoot must be a normalized absolute path");
  assert.ok(resolve(manifestPath) === manifestPath, "manifestPath must be a normalized absolute path");

  const resolvedBundleRoot = resolve(bundleRoot);
  const resolvedManifestPath = resolve(manifestPath);
  let initialSource;
  let ownedRoot;
  try {
    initialSource = await validateRetainedExport({
      bundleRoot: resolvedBundleRoot,
      manifestPath: resolvedManifestPath,
      expectedSourceTreeSha256,
      expectedManifestSha256,
      expectedBundleSha256,
      expectedBundleFileCount,
    });

    await assertNoSymlinkPath(context.stateDir, "directory");
    ownedRoot = context.pathInState(outputName);
    assertContained(context.stateDir, ownedRoot, "owned output must remain in this RunContext state");
    await assertPathDoesNotExist(ownedRoot);
    await mkdir(ownedRoot, { recursive: false, mode: 0o700 });
    context.registerTemporaryDirectory(`reused Mobile Web export ${label}`, ownedRoot);

    try {
      for (const file of initialSource.files) {
        await copyAndVerifyFile(resolvedBundleRoot, ownedRoot, file);
      }
      await verifyBundleTree(ownedRoot, initialSource.files);

      const finalSource = await validateRetainedExport({
        bundleRoot: resolvedBundleRoot,
        manifestPath: resolvedManifestPath,
        expectedSourceTreeSha256,
        expectedManifestSha256,
        expectedBundleSha256,
        expectedBundleFileCount,
      });
      assert.equal(finalSource.manifestSha256, initialSource.manifestSha256, "source manifest changed during reuse");
      assert.equal(finalSource.bundleSha256, initialSource.bundleSha256, "source bundle changed during reuse");

      const ownedCopySha256 = aggregateFiles(initialSource.files);
      assert.equal(ownedCopySha256, initialSource.bundleSha256, "owned copy aggregate does not match the source manifest");
      const provenance = {
        schemaVersion: 1,
        status: "complete",
        kind: "reused-retained-public-mobile-web-export",
        exportPerformed: false,
        sourceArtifact: {
          manifestPath: toRepoRelative(resolvedManifestPath),
          manifestSha256: initialSource.manifestSha256,
          expectedManifestSha256: expectedManifestSha256 ?? null,
          manifestPinStatus: expectedManifestSha256 ? "matched" : "not-provided",
          sourceTreeSha256: initialSource.sourceTreeSha256,
          expectedSourceTreeSha256,
          sourceTreeStatus: "manifest-digest-matches-expected-snapshot",
          bundleRoot: toRepoRelative(resolvedBundleRoot),
          bundleSha256: initialSource.bundleSha256,
          expectedBundleSha256: expectedBundleSha256 ?? null,
          bundlePinStatus: expectedBundleSha256 ? "matched" : "not-provided",
          bundleFileCount: initialSource.files.length,
          indexHtmlSha256: initialSource.indexHtmlSha256,
          sourceManifestAndBundleUnchangedDuringCopy: true,
        },
        ownedCopy: {
          path: relative(context.runRoot, ownedRoot).split(sep).join("/"),
          bundleSha256: ownedCopySha256,
          bundleFileCount: initialSource.files.length,
          indexHtmlSha256: initialSource.indexHtmlSha256,
          filesVerifiedAgainstManifest: true,
          extraFiles: 0,
          symlinks: 0,
        },
      };
      const provenancePath = await context.writeArtifactJson(`${label}-reuse-provenance.json`, provenance);
      return {
        path: ownedRoot,
        sourceManifestPath: resolvedManifestPath,
        sourceManifestSha256: initialSource.manifestSha256,
        expectedManifestSha256: expectedManifestSha256 ?? null,
        sourceTreeSha256: initialSource.sourceTreeSha256,
        bundleSha256: initialSource.bundleSha256,
        expectedBundleSha256: expectedBundleSha256 ?? null,
        bundleFiles: initialSource.files,
        bundleFileCount: initialSource.files.length,
        indexHtmlSha256: initialSource.indexHtmlSha256,
        provenancePath,
        exportPerformed: false,
      };
    } catch (error) {
      await rm(ownedRoot, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    const message = context.redactText?.(error instanceof Error ? error.message : String(error)) ?? String(error);
    throw new Error(`Mobile Web export reuse failed: ${message}`);
  }
}

async function validateRetainedExport({
  bundleRoot,
  manifestPath,
  expectedSourceTreeSha256,
  expectedManifestSha256,
  expectedBundleSha256,
  expectedBundleFileCount,
}) {
  assertContained(artifactBoundary, manifestPath, "source manifest must be inside the E2E artifact boundary");
  assert.equal(basename(dirname(manifestPath)), "artifacts", "source manifest must be a direct child of a run artifacts directory");
  const sourceArtifactsDirectory = dirname(manifestPath);
  const sourceRunRoot = dirname(sourceArtifactsDirectory);
  assertContained(artifactBoundary, sourceRunRoot, "source run must be inside the E2E artifact boundary");
  assert.ok(sourceRunRoot !== artifactBoundary, "source manifest must belong to a completed E2E run");

  await assertNoSymlinkPath(manifestPath, "file");
  const manifestBytes = await readRegularFile(manifestPath, maximumManifestBytes);
  const manifestSha256 = hashBytes(manifestBytes);
  if (expectedManifestSha256) {
    assert.equal(manifestSha256, expectedManifestSha256, "retained source manifest does not match the expected SHA-256 pin");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("source export manifest is not valid JSON");
  }
  assert.ok(manifest && typeof manifest === "object" && !Array.isArray(manifest), "source export manifest must be an object");
  assert.deepEqual(new Set(Object.keys(manifest)), expectedSourceManifestKeys, "source export manifest has unexpected or missing fields");
  assert.equal(manifest.schemaVersion, 1, "source export manifest schema version must be 1");
  assert.equal(manifest.sourceTreeSha256, expectedSourceTreeSha256, "source export manifest does not match the expected source tree digest");
  assert.ok(/^[a-f0-9]{64}$/.test(manifest.sourceTreeSha256), "source tree SHA-256 is invalid");
  assert.ok(typeof manifest.purpose === "string" && manifest.purpose.length <= 256, "source export purpose is invalid");
  assert.ok(typeof manifest.sourceCommit === "string" || manifest.sourceCommit === null, "source commit metadata is invalid");
  assert.ok(/^[a-f0-9]{64}$/.test(manifest.bundleSha256), "bundle SHA-256 is invalid");
  if (expectedBundleSha256) {
    assert.equal(manifest.bundleSha256, expectedBundleSha256, "retained Mobile Web bundle does not match the expected SHA-256 pin");
  }
  assert.ok(/^[a-f0-9]{64}$/.test(manifest.indexHtmlSha256), "index.html SHA-256 is invalid");
  assert.equal(manifest.bundleFileCount, expectedBundleFileCount, `source export must list exactly ${expectedBundleFileCount} public bundle files`);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === expectedBundleFileCount,
    `source export file table must contain exactly ${expectedBundleFileCount} entries`);
  assert.equal(aggregateFiles(manifest.files), manifest.bundleSha256, "bundle aggregate does not match the original ordered file table");

  const relativeBundleDirectory = assertSafeRelativePath(manifest.directory, "manifest bundle directory");
  assert.ok(relativeBundleDirectory.startsWith("artifacts/"), "manifest bundle directory must be under the run artifacts directory");
  const expectedBundleRoot = resolve(sourceRunRoot, relativeBundleDirectory);
  assert.equal(bundleRoot, expectedBundleRoot, "bundleRoot must match the source manifest artifact directory");
  assertContained(sourceRunRoot, bundleRoot, "source bundle must remain inside its E2E run");
  await assertNoSymlinkPath(bundleRoot, "directory");

  const seen = new Set();
  const files = [];
  let totalBytes = 0;
  let indexHtmlCount = 0;
  for (const file of manifest.files) {
    assert.ok(file && typeof file === "object" && !Array.isArray(file), "source file table entry must be an object");
    assert.equal(Object.keys(file).join(","), "path,size,sha256", "source file table entry has unexpected fields or field order");
    const filePath = assertSafeRelativePath(file.path, "bundle file path");
    assertPublicAssetPath(filePath);
    assert.ok(!seen.has(filePath), "source file table contains a duplicate path");
    seen.add(filePath);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0, "source file size is invalid");
    assert.ok(/^[a-f0-9]{64}$/.test(file.sha256), "source file SHA-256 is invalid");
    totalBytes += file.size;
    assert.ok(totalBytes <= maximumBundleBytes, "source Mobile Web bundle exceeds the allowed copy size");
    if (filePath === "index.html") {
      indexHtmlCount += 1;
      assert.equal(file.sha256, manifest.indexHtmlSha256, "indexHtmlSha256 does not match the index.html table entry");
    }
    files.push(file);
  }
  assert.equal(indexHtmlCount, 1, "source file table must contain exactly one root index.html");
  await verifyBundleTree(bundleRoot, files);

  return {
    manifestSha256,
    sourceTreeSha256: manifest.sourceTreeSha256,
    bundleSha256: manifest.bundleSha256,
    indexHtmlSha256: manifest.indexHtmlSha256,
    files,
  };
}

async function verifyBundleTree(root, files) {
  await assertNoSymlinkPath(root, "directory");
  const expectedFiles = new Map(files.map(file => [file.path, file]));
  const expectedDirectories = new Set();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      expectedDirectories.add(parts.slice(0, index).join("/"));
    }
  }

  const actualFiles = new Set();
  const actualDirectories = new Set();
  async function visit(directory, prefix = "") {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      const safePath = assertSafeRelativePath(relativePath, "bundle entry path");
      const absolutePath = resolve(directory, child.name);
      const info = await lstat(absolutePath);
      assert.ok(!info.isSymbolicLink(), "source and owned Mobile Web bundles cannot contain symlinks");
      if (info.isDirectory()) {
        actualDirectories.add(safePath);
        await visit(absolutePath, safePath);
      } else {
        assert.ok(info.isFile(), "source and owned Mobile Web bundles cannot contain special files");
        assertPublicAssetPath(safePath);
        actualFiles.add(safePath);
      }
    }
  }
  await visit(root);

  assert.equal(actualFiles.size, expectedFiles.size, "bundle tree contains missing or extra files");
  assert.equal(actualDirectories.size, expectedDirectories.size, "bundle tree contains missing or extra directories");
  for (const filePath of actualFiles) {
    assert.ok(expectedFiles.has(filePath), "bundle tree contains a file not listed by the source manifest");
  }
  for (const directory of actualDirectories) {
    assert.ok(expectedDirectories.has(directory), "bundle tree contains an unlisted directory");
  }

  for (const file of files) {
    const absolutePath = resolve(root, ...file.path.split("/"));
    const digest = await hashRegularFile(absolutePath);
    assert.equal(digest.size, file.size, "bundle file size does not match the source manifest");
    assert.equal(digest.sha256, file.sha256, "bundle file SHA-256 does not match the source manifest");
  }
}

async function copyAndVerifyFile(sourceRoot, destinationRoot, file) {
  const sourcePath = resolve(sourceRoot, ...file.path.split("/"));
  const destinationPath = resolve(destinationRoot, ...file.path.split("/"));
  await assertNoSymlinkPath(sourcePath, "file");
  await createOwnedParentDirectories(destinationRoot, file.path.split("/").slice(0, -1));
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const sourceHandle = await open(sourcePath, constants.O_RDONLY | noFollow);
  let destinationHandle;
  try {
    const sourceInfo = await sourceHandle.stat();
    assert.ok(sourceInfo.isFile(), "manifest-listed source entry is not a regular file");
    destinationHandle = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(fileReadChunkBytes);
    let totalBytes = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, totalBytes);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(chunk, written, bytesRead - written, totalBytes + written);
        assert.ok(result.bytesWritten > 0, "owned bundle copy stopped making progress");
        written += result.bytesWritten;
      }
      totalBytes += bytesRead;
    }
    await destinationHandle.sync();
    assert.equal(totalBytes, file.size, "copied bundle file size does not match the source manifest");
    assert.equal(digest.digest("hex"), file.sha256, "copied bundle file SHA-256 does not match the source manifest");
  } finally {
    await sourceHandle.close();
    await destinationHandle?.close();
  }
}

async function createOwnedParentDirectories(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      await mkdir(current, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), "owned bundle parent must be a real directory");
  }
}

async function readRegularFile(path, maximumBytes) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    assert.ok(info.isFile(), "source manifest must be a regular file");
    assert.ok(info.size <= maximumBytes, "source manifest exceeds the allowed size");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function hashRegularFile(path) {
  await assertNoSymlinkPath(path, "file");
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    assert.ok(info.isFile(), "bundle entry must be a regular file");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(fileReadChunkBytes);
    let totalBytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, totalBytes);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
      assert.ok(totalBytes <= maximumBundleBytes, "bundle file exceeds the allowed copy size");
    }
    return { size: totalBytes, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function assertNoSymlinkPath(path, leafType) {
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const parts = relative(root, normalized).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("source or owned path is missing");
      throw error;
    }
    assert.ok(!info.isSymbolicLink(), "source and owned paths cannot traverse symlinks");
    if (index < parts.length - 1) assert.ok(info.isDirectory(), "source and owned parent paths must be directories");
    else if (leafType === "directory") assert.ok(info.isDirectory(), "source bundle root must be a directory");
    else assert.ok(info.isFile(), "source manifest or bundle file must be a regular file");
  }
}

async function assertPathDoesNotExist(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("owned output already exists; refusing to reuse prior state");
}

function assertSafeRelativePath(value, description) {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 1024, `${description} is invalid`);
  assert.ok(!value.startsWith("/") && !value.includes("\\") && !value.includes("\0"), `${description} must be a safe relative path`);
  const parts = value.split("/");
  assert.ok(parts.every(part => part && part !== "." && part !== ".." && !/[\u0000-\u001f\u007f]/.test(part)), `${description} contains an unsafe path segment`);
  assert.ok(parts.every(part => !part.includes(":")), `${description} contains a platform-specific path separator`);
  return value;
}

function assertPublicAssetPath(value) {
  const parts = value.toLowerCase().split("/");
  assert.ok(!parts.some(part => /^\.env(?:$|[._-])/.test(part)), "Mobile Web bundle cannot contain environment files");
  assert.ok(!parts.some(part => part === ".npmrc" || part === ".netrc"), "Mobile Web bundle cannot contain package or network credentials");
  assert.ok(!parts.some(part => /(?:^|[._-])(?:credential|credentials|secret|secrets|token|tokens|privatekey|private-key|api[-_.]?key|keys?)(?:[._-]|$)/.test(part)), "Mobile Web bundle cannot contain credentials or key material");
  assert.ok(!parts.some(part => /\.(?:pem|key|p12|pfx|keystore|jks)$/.test(part)), "Mobile Web bundle cannot contain private key or certificate files");

  const nodeModulesIndexes = parts.flatMap((part, index) => part === "node_modules" ? [index] : []);
  if (nodeModulesIndexes.length > 0) {
    const imageAsset = /\.(?:png|svg|webp|jpe?g|gif)$/i.test(value);
    const allowedStaticAsset = parts[0] === "assets" && nodeModulesIndexes.length === 1 && nodeModulesIndexes[0] === 1 && imageAsset;
    assert.ok(allowedStaticAsset, "Mobile Web bundle cannot contain node_modules except manifest-listed static image assets");
  }
}

function aggregateFiles(files) {
  return hashBytes(Buffer.from(JSON.stringify(files)));
}

function assertContained(root, candidate, message) {
  const relativePath = relative(resolve(root), resolve(candidate));
  assert.ok(relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath), message);
}

function toRepoRelative(path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function assertSafeSlug(value, label) {
  assert.ok(typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,126}$/.test(value), `${label} must be a simple filesystem slug`);
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}
