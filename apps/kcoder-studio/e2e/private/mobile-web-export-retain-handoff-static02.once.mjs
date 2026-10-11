import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const SOURCE_BATCH_RELATIVE = "target/private-phone-ux-implementation/mobile-web-export-durable-task-handoff-static02-20261008";
const EXPECTED_MANIFEST_SHA256 = "fc39e5799950ce36cb9010c3aa5d565aa2d98c14575664f47b6b2a8153ce8c44";
const EXPECTED_PROVENANCE_SHA256 = "d2f2c28054e198e4ff2c6e581c38d0f34ef70fa02491e444374e84676dc02bd9";
const EXPECTED_SOURCE_TREE_SHA256 = "8623b4e873e21303b40ea1f04b7107fd67a54f746ac328515542bf6ffee79892";
const EXPECTED_BUNDLE_SHA256 = "19e436780ffcef29bee9cac8aab1943e48fc5f1169d1ce7375d283f32dd18067";
const EXPECTED_INDEX_HTML_SHA256 = "31618b9f98362e88fa19e95be14f6faa8c674072691c3c91241cec10ffab17ad";
const EXPECTED_FILE_COUNT = 37;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

await runE2E(import.meta.url, {
  testId: "mobile-web-export-retain-handoff-static02-once",
  tier: "local-retain-adapter",
  modelPolicy: "local-only validation and copy of a hash-pinned public Mobile Web export; no build, service, browser, or model",
  retainSuccessLogs: true,
}, async context => {
  const sourceBatch = resolve(repoRoot, SOURCE_BATCH_RELATIVE);
  const sourceBundleRoot = resolve(sourceBatch, "export");
  const sourceManifestPath = resolve(sourceBatch, "export-manifest.json");
  const sourceProvenancePath = resolve(sourceBatch, "export-provenance.json");
  assertContained(repoRoot, sourceBatch);
  assertContained(sourceBatch, sourceBundleRoot);
  await assertNoSymlinkPath(sourceBatch);

  const manifestBytesBefore = await readNoFollowRegularFile(sourceManifestPath, MAX_METADATA_BYTES);
  const provenanceBytesBefore = await readNoFollowRegularFile(sourceProvenancePath, MAX_METADATA_BYTES);
  assert.equal(sha256(manifestBytesBefore), EXPECTED_MANIFEST_SHA256, "portable schema-2 manifest does not match its fixed SHA-256 pin");
  assert.equal(sha256(provenanceBytesBefore), EXPECTED_PROVENANCE_SHA256, "portable provenance sidecar does not match its fixed SHA-256 pin");
  const portableManifest = parseJson(manifestBytesBefore, "portable export manifest");
  const portableProvenance = parseJson(provenanceBytesBefore, "portable export provenance");
  validatePortableInputs({
    portableManifest,
    portableProvenance,
    sourceManifestPath,
    sourceProvenancePath,
    sourceBundleRoot,
  });

  const sourceBefore = await inspectBundle(sourceBundleRoot, portableManifest.bundleFiles);
  assert.equal(sourceBefore.bundleSha256, EXPECTED_BUNDLE_SHA256, "pre-copy source bundle aggregate does not match its fixed pin");
  assert.equal(sourceBefore.indexHtmlSha256, EXPECTED_INDEX_HTML_SHA256, "pre-copy index.html does not match its fixed pin");

  const bundleRoot = context.pathInArtifacts("handoff-mobile-web-export");
  await mkdir(bundleRoot, { recursive: false, mode: 0o700 });
  await assertNoSymlinkPath(bundleRoot);
  for (const file of portableManifest.bundleFiles) {
    const bytes = await readListedSourceFile(sourceBundleRoot, file);
    const destination = await createOwnedDestinationPath(bundleRoot, file.path);
    await writeNewPrivateFile(destination, bytes);
    const copied = await readNoFollowRegularFile(destination, file.size);
    assert.equal(copied.length, file.size, `copied size mismatch for ${file.path}`);
    assert.equal(sha256(copied), file.sha256, `copied SHA-256 mismatch for ${file.path}`);
  }

  const ownedBundle = await inspectBundle(bundleRoot, portableManifest.bundleFiles);
  assert.deepEqual(ownedBundle, sourceBefore, "owned artifact bundle must exactly match the source pre-copy snapshot");

  const retainedManifest = {
    schemaVersion: 1,
    purpose: "Hash-verified public Mobile Web export retained for durable handoff E2E",
    sourceCommit: typeof portableProvenance.sourceCommit === "string" ? portableProvenance.sourceCommit : null,
    sourceTreeSha256: EXPECTED_SOURCE_TREE_SHA256,
    bundleSha256: EXPECTED_BUNDLE_SHA256,
    bundleFileCount: EXPECTED_FILE_COUNT,
    indexHtmlSha256: EXPECTED_INDEX_HTML_SHA256,
    directory: relative(context.runRoot, bundleRoot).split(sep).join("/"),
    files: portableManifest.bundleFiles.map(({ path, size, sha256: fileSha256 }) => ({ path, size, sha256: fileSha256 })),
  };
  assert.deepEqual(Object.keys(retainedManifest), [
    "schemaVersion", "purpose", "sourceCommit", "sourceTreeSha256", "bundleSha256",
    "bundleFileCount", "indexHtmlSha256", "directory", "files",
  ], "adapter manifest must match the helper's exact nine-key schema");
  assert.equal(retainedManifest.directory, "artifacts/handoff-mobile-web-export");
  assert.equal(sha256(Buffer.from(JSON.stringify(retainedManifest.files))), EXPECTED_BUNDLE_SHA256,
    "schema-1 file table must retain the portable manifest's ordered bundle aggregate");

  const retainedManifestPath = context.pathInArtifacts("handoff-mobile-web-export-manifest.schema1.json");
  const retainedPortableManifestPath = context.pathInArtifacts("handoff-portable-export-manifest.schema2.json");
  const retainedProvenancePath = context.pathInArtifacts("handoff-portable-export-provenance.json");
  await writeNewPrivateFile(retainedPortableManifestPath, manifestBytesBefore);
  await writeNewPrivateFile(retainedProvenancePath, provenanceBytesBefore);
  assert.equal(sha256(await readNoFollowRegularFile(retainedPortableManifestPath, MAX_METADATA_BYTES)), EXPECTED_MANIFEST_SHA256,
    "retained original schema-2 sidecar must preserve exact bytes");
  assert.equal(sha256(await readNoFollowRegularFile(retainedProvenancePath, MAX_METADATA_BYTES)), EXPECTED_PROVENANCE_SHA256,
    "retained provenance sidecar must preserve exact bytes");
  await context.writeArtifactJson("handoff-mobile-web-export-manifest.schema1.json", retainedManifest);
  const writtenManifestBytes = await readNoFollowRegularFile(retainedManifestPath, MAX_METADATA_BYTES);
  const writtenManifest = parseJson(writtenManifestBytes, "retained schema-1 manifest");
  assert.deepEqual(Object.keys(writtenManifest), Object.keys(retainedManifest), "written adapter manifest must have exactly nine keys");
  assert.equal(writtenManifest.sourceTreeSha256, EXPECTED_SOURCE_TREE_SHA256);
  assert.equal(writtenManifest.bundleSha256, EXPECTED_BUNDLE_SHA256);
  assert.equal(writtenManifest.bundleFileCount, EXPECTED_FILE_COUNT);
  assert.equal(writtenManifest.directory, retainedManifest.directory);
  assert.deepEqual(writtenManifest.files, retainedManifest.files);

  const sourceAfter = await inspectBundle(sourceBundleRoot, portableManifest.bundleFiles);
  const manifestBytesAfter = await readNoFollowRegularFile(sourceManifestPath, MAX_METADATA_BYTES);
  const provenanceBytesAfter = await readNoFollowRegularFile(sourceProvenancePath, MAX_METADATA_BYTES);
  assert.deepEqual(sourceAfter, sourceBefore, "portable source bundle changed during local retention");
  assert.equal(sha256(manifestBytesAfter), EXPECTED_MANIFEST_SHA256, "portable schema-2 manifest changed during local retention");
  assert.equal(sha256(provenanceBytesAfter), EXPECTED_PROVENANCE_SHA256, "portable provenance sidecar changed during local retention");

  const evidence = {
    status: "PASS",
    sourceBatchRelative: SOURCE_BATCH_RELATIVE,
    sourceManifestSha256: EXPECTED_MANIFEST_SHA256,
    sourceProvenanceSha256: EXPECTED_PROVENANCE_SHA256,
    sourceTreeSha256: EXPECTED_SOURCE_TREE_SHA256,
    bundleSha256: EXPECTED_BUNDLE_SHA256,
    bundleFileCount: EXPECTED_FILE_COUNT,
    indexHtmlSha256: EXPECTED_INDEX_HTML_SHA256,
    sourceBundleBefore: sourceBefore,
    ownedBundle: ownedBundle,
    sourceBundleAfter: sourceAfter,
    sourceManifestUnchanged: true,
    sourceProvenanceUnchanged: true,
    sourceAndDestinationNoSymlinks: true,
    portableSchema2SidecarsPreservedByteForByte: true,
    helperCompatibleSchema1Manifest: relative(context.runRoot, retainedManifestPath).split(sep).join("/"),
    adapterScope: "local-only retained public bundle copy; no export, build, Gateway, browser, or model invocation",
  };
  await context.writeArtifactJson("handoff-export-retain-adapter-evidence.json", evidence);
  return evidence;
});

function validatePortableInputs({ portableManifest, portableProvenance, sourceManifestPath, sourceProvenancePath, sourceBundleRoot }) {
  assert.equal(portableManifest.schemaVersion, 2, "input must be the portable schema-2 export manifest");
  assert.equal(portableManifest.status, "complete");
  assert.equal(portableManifest.failurePhase, null);
  assert.equal(portableManifest.sourceTreeSha256, EXPECTED_SOURCE_TREE_SHA256);
  assert.equal(portableManifest.bundleSha256, EXPECTED_BUNDLE_SHA256);
  assert.equal(portableManifest.bundleFileCount, EXPECTED_FILE_COUNT);
  assert.equal(portableManifest.indexHtmlSha256, EXPECTED_INDEX_HTML_SHA256);
  assert.equal(portableManifest.sourceUnchanged, true);
  assert.equal(portableManifest.snapshotCopyMatchesSource, true);
  assert.equal(portableManifest.snapshotUnchangedDuringExport, true);
  assert.equal(portableManifest.error, null);
  assert.ok(Array.isArray(portableManifest.bundleFiles) && portableManifest.bundleFiles.length === EXPECTED_FILE_COUNT,
    "portable schema-2 manifest must contain its exact 37-file table");

  assert.equal(portableProvenance.status, "complete");
  assert.equal(portableProvenance.candidateSourceDigest, EXPECTED_SOURCE_TREE_SHA256,
    "portable provenance must identify the pinned candidate source tree");
  assert.equal(portableProvenance.bundleSha256, EXPECTED_BUNDLE_SHA256);
  assert.equal(portableProvenance.bundleFileCount, EXPECTED_FILE_COUNT);
  assert.equal(portableProvenance.indexHtmlSha256, EXPECTED_INDEX_HTML_SHA256);
  assert.equal(portableProvenance.sourceCommit, "09d1e88342909b36237a571774d2987fa2a8556c");
  assert.equal(resolve(portableProvenance.bundleManifestPath), sourceManifestPath,
    "provenance must identify the pinned schema-2 manifest");
  assert.equal(resolve(portableProvenance.portableProvenancePath), sourceProvenancePath,
    "provenance must identify its pinned sidecar");
  assert.equal(resolve(portableProvenance.bundlePath), sourceBundleRoot,
    "provenance must identify the pinned portable bundle directory");
  assert.ok(portableProvenance.sourceUnchanged === true && portableProvenance.snapshotCopyMatchesSource === true
    && portableProvenance.snapshotUnchangedDuringExport === true,
  "portable provenance must confirm the source and export snapshots were unchanged");
  assert.equal(typeof portableProvenance.sourceCommit === "string" || portableProvenance.sourceCommit === null, true,
    "source commit metadata must be a string or null");
}

async function inspectBundle(root, files) {
  await assertNoSymlinkPath(root);
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "bundle root must be a real directory");
  const listed = new Set();
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  assert.ok(totalBytes <= MAX_BUNDLE_BYTES, "bundle exceeds the local adapter copy limit");
  for (const file of files) {
    validatePublicBundleFile(file);
    assert.ok(!listed.has(file.path), "bundle table has duplicate paths");
    listed.add(file.path);
    const bytes = await readListedSourceFile(root, file);
    assert.equal(bytes.length, file.size, `source size mismatch for ${file.path}`);
    assert.equal(sha256(bytes), file.sha256, `source SHA-256 mismatch for ${file.path}`);
  }

  const actualFiles = new Set();
  const actualDirectories = new Set();
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = resolve(directory, entry.name);
      const info = await lstat(fullPath);
      assert.ok(!info.isSymbolicLink(), "bundle tree cannot contain symlinks");
      if (info.isDirectory()) {
        actualDirectories.add(relativePath);
        await walk(fullPath, relativePath);
      } else {
        assert.ok(info.isFile(), "bundle tree contains a non-regular file");
        actualFiles.add(relativePath);
      }
    }
  }
  await walk(root);
  assert.deepEqual([...actualFiles].sort(), [...listed].sort(), "bundle tree has missing or unlisted files");
  const expectedDirectories = new Set();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) expectedDirectories.add(parts.slice(0, index).join("/"));
  }
  assert.deepEqual([...actualDirectories].sort(), [...expectedDirectories].sort(), "bundle tree has unexpected empty directories");
  const indexHtml = files.filter(file => file.path === "index.html");
  assert.equal(indexHtml.length, 1, "bundle table must contain exactly one root index.html");
  assert.equal(indexHtml[0].sha256, EXPECTED_INDEX_HTML_SHA256, "index.html hash mismatch");
  const bundleSha256 = sha256(Buffer.from(JSON.stringify(files.map(({ path, size, sha256: fileSha256 }) => ({ path, size, sha256: fileSha256 })))));
  return { bundleSha256, bundleFileCount: actualFiles.size, totalBytes, indexHtmlSha256: indexHtml[0].sha256 };
}

async function readListedSourceFile(root, file) {
  const parts = validatePublicBundleFile(file);
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), "bundle path parent must be a real directory");
  }
  const filePath = resolve(cursor, parts.at(-1));
  assertContained(root, filePath);
  const bytes = await readNoFollowRegularFile(filePath, file.size);
  assert.equal(bytes.length, file.size, `bundle file size mismatch for ${file.path}`);
  assert.equal(sha256(bytes), file.sha256, `bundle file hash mismatch for ${file.path}`);
  return bytes;
}

function validatePublicBundleFile(file) {
  assert.ok(file && typeof file === "object" && !Array.isArray(file), "bundle file entry must be an object");
  assert.deepEqual(Object.keys(file), ["path", "size", "sha256"], "bundle file entry must use path,size,sha256 fields");
  assert.ok(typeof file.path === "string" && file.path.length > 0 && file.path.length <= 1024,
    "bundle file path is invalid");
  assert.ok(!file.path.startsWith("/") && !file.path.includes("\\") && !file.path.includes("\0"),
    "bundle file path must be relative and platform-neutral");
  const parts = file.path.split("/");
  assert.ok(parts.every(part => part && part !== "." && part !== ".." && !part.includes(":") && !/[\x00-\x1f\x7f]/.test(part)),
    "bundle file path contains an unsafe segment");
  const lowerParts = parts.map(part => part.toLowerCase());
  assert.ok(!lowerParts.some(part => /^\.env(?:$|[._-])/.test(part) || part === ".npmrc" || part === ".netrc"),
    "public bundle cannot contain environment or package credential files");
  assert.ok(!lowerParts.some(part => /(?:^|[._-])(?:credential|credentials|secret|secrets|token|tokens|privatekey|private-key|api[-_.]?key|keys?)(?:[._-]|$)/.test(part)),
    "public bundle cannot contain credential or key material");
  assert.ok(!lowerParts.some(part => /\.(?:pem|key|p12|pfx|keystore|jks)$/.test(part)),
    "public bundle cannot contain private keys or certificates");
  const nodeModules = lowerParts.flatMap((part, index) => part === "node_modules" ? [index] : []);
  if (nodeModules.length) {
    const imageAsset = /\.(?:png|svg|webp|jpe?g|gif)$/i.test(file.path);
    assert.ok(parts[0] === "assets" && nodeModules.length === 1 && nodeModules[0] === 1 && imageAsset,
      "node_modules entries are permitted only for manifest-listed public image assets");
  }
  assert.ok(Number.isSafeInteger(file.size) && file.size >= 0, "bundle file size is invalid");
  assert.ok(/^[a-f0-9]{64}$/.test(file.sha256), "bundle file SHA-256 is invalid");
  return parts;
}

async function createOwnedDestinationPath(root, relativePath) {
  const parts = relativePath.split("/");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = resolve(cursor, part);
    try {
      await mkdir(cursor, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(cursor);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), "owned bundle parent must be a real directory");
  }
  const destination = resolve(cursor, parts.at(-1));
  assertContained(root, destination);
  return destination;
}

async function readNoFollowRegularFile(path, maximumBytes) {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = await handle.stat();
    assert.ok(info.isFile(), "pinned input must be a regular file");
    assert.ok(info.size <= maximumBytes, "pinned input exceeds the local adapter read limit");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeNewPrivateFile(path, bytes) {
  await assertNoSymlinkPath(dirname(path));
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertNoSymlinkPath(path) {
  const absolute = resolve(path);
  const segments = absolute.split(sep).filter(Boolean);
  let cursor = absolute.startsWith(sep) ? sep : "";
  for (const segment of segments) {
    cursor = resolve(cursor || ".", segment);
    const info = await lstat(cursor);
    assert.ok(!info.isSymbolicLink(), "adapter input/output paths cannot contain symlinks");
  }
}

function assertContained(root, candidate) {
  const path = relative(resolve(root), resolve(candidate));
  assert.ok(path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)),
    "adapter path escaped its owned root");
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
