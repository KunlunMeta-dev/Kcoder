// Derive a copy-helper-compatible packaging of the already frozen 315-file
// static-02 candidate. Product source bytes and the source manifest stay exact.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { repoRoot } from "../harness/run-context.mjs";

const INPUT_ROOT = resolve(
  repoRoot,
  "target/private-phone-ux-implementation/worktree-handoff-discovery-static02-20261008",
);
const OUTPUT_ROOT = resolve(
  repoRoot,
  "target/private-phone-ux-implementation/worktree-handoff-discovery-static02-20261008-copyable",
);
const EXPECTED_INPUT = {
  freeze: "a4c6b30d13638089ecb4b6fa526e197f74e770a46d7dc6d8175690e1de24fee1",
  shaMap: "380efa25f6c671f0474270bd888e3cb28f1c73ecf7346262358572f557ae3341",
  sourceFiles: "6c760912e1163d5e29fae81ce8f1db34ac7a6a1f08e529d54bad5da5e2a6ff54",
  candidateManifest: "19d067e6f94c9f60b4e83fcd5d6dc1e522cb5108738b801105995df6ba9bc788",
  metadata: "bec6ce327573fe640ad13ac1224d87dd50377d826b320c07f3df56bd996740d6",
  overlayDiff: "e572050ab7393f6d6787659bb8822c07d03d52ea8f1f99c2f545c7c0ae89296c",
  sourceDigest: "2b9bf9e9e6f623962d04c3561e7130d186d79b91e38fe206cfae79f74154af02",
  count: 315,
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

async function assertDirectory(path, mode, label) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a real directory`);
  assert.equal(await realpath(path), path, `${label} must be canonical`);
  if (mode !== undefined) assert.equal(info.mode & 0o777, mode, `${label} permissions changed`);
  return info;
}

async function readPinned(path, expectedSha, label) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  assert.equal(info.mode & 0o222, 0, `${label} must remain read-only`);
  const bytes = await readFile(path);
  assert.equal(sha256(bytes), expectedSha, `${label} digest changed`);
  return bytes;
}

async function collectSource(root) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const path = relative(root, absolute).split(sep).join("/");
      const info = await lstat(absolute);
      assert.ok(!info.isSymbolicLink(), `input candidate contains symlink: ${path}`);
      assert.equal(info.mode & 0o222, 0, `input candidate is writable: ${path}`);
      if (info.isDirectory()) await visit(absolute);
      else if (info.isFile()) {
        const bytes = await readFile(absolute);
        entries.push({ path, size: bytes.length, sha256: sha256(bytes), bytes });
      } else assert.fail(`input candidate contains a special file: ${path}`);
    }
  }
  await visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

async function writeReadonly(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(path, 0o400);
}

async function freezeDirectories(root) {
  for (const child of await readdir(root, { withFileTypes: true })) {
    if (child.isDirectory()) await freezeDirectories(join(root, child.name));
  }
  await chmod(root, 0o555);
}

async function assertAbsent(path) {
  await lstat(path).then(() => assert.fail(`output already exists; refusing overwrite: ${path}`), error => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function main() {
  await assertDirectory(INPUT_ROOT, 0o555, "original static-02 315 candidate");
  await assertDirectory(resolve(INPUT_ROOT, "source"), 0o555, "original static-02 source tree");
  await assertDirectory(dirname(OUTPUT_ROOT), undefined, "private output parent");
  await assertAbsent(OUTPUT_ROOT);
  const [freezeBytes, oldMapBytes, sourceFilesBytes, candidateManifestBytes, metadataBytes, overlayDiffBytes] = await Promise.all([
    readPinned(resolve(INPUT_ROOT, "freeze.json"), EXPECTED_INPUT.freeze, "original candidate freeze"),
    readPinned(resolve(INPUT_ROOT, "sha256.json"), EXPECTED_INPUT.shaMap, "original candidate SHA map"),
    readPinned(resolve(INPUT_ROOT, "source-files.json"), EXPECTED_INPUT.sourceFiles, "original source manifest"),
    readPinned(resolve(INPUT_ROOT, "candidate-manifest.json"), EXPECTED_INPUT.candidateManifest, "original candidate manifest"),
    readPinned(resolve(INPUT_ROOT, "metadata.json"), EXPECTED_INPUT.metadata, "original candidate metadata"),
    readPinned(resolve(INPUT_ROOT, "overlay.diff"), EXPECTED_INPUT.overlayDiff, "original overlay diff"),
  ]);
  const freeze = JSON.parse(freezeBytes.toString("utf8"));
  const oldShaMap = JSON.parse(oldMapBytes.toString("utf8"));
  const sourceFiles = JSON.parse(sourceFilesBytes.toString("utf8"));
  const candidateManifest = JSON.parse(candidateManifestBytes.toString("utf8"));
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  assert.equal(freeze.sourceDigest, EXPECTED_INPUT.sourceDigest);
  assert.equal(freeze.count, EXPECTED_INPUT.count);
  assert.equal(sourceFiles.sourceDigest, EXPECTED_INPUT.sourceDigest);
  assert.equal(sourceFiles.count, EXPECTED_INPUT.count);
  assert.equal(candidateManifest.sourceDigest, EXPECTED_INPUT.sourceDigest);
  assert.equal(candidateManifest.fileCount, EXPECTED_INPUT.count);
  assert.equal(metadata.sourceDigest, EXPECTED_INPUT.sourceDigest);
  assert.equal(Object.keys(oldShaMap).length, EXPECTED_INPUT.count);
  const sourceRoot = resolve(INPUT_ROOT, "source");
  const actual = await collectSource(sourceRoot);
  assert.equal(actual.length, EXPECTED_INPUT.count);
  assert.deepEqual(actual.map(({ path, size, sha256: fileSha }) => ({ path, size, sha256: fileSha })), candidateManifest.files);
  const expectedShaMap = Object.fromEntries(actual.map(({ path, sha256: fileSha }) => [path, fileSha]));
  assert.deepEqual(oldShaMap, expectedShaMap);

  const prefixedShaMap = Object.fromEntries(actual.map(({ path, sha256: fileSha }) => [`source/${path}`, fileSha]));
  const prefixedShaMapBytes = Buffer.from(`${JSON.stringify(prefixedShaMap, null, 2)}\n`);
  const copyMetadata = {
    ...metadata,
    sha256MapSha256: sha256(prefixedShaMapBytes),
    copyVerifiedSnapshotLayout: {
      derivedFromCandidateRoot: relative(repoRoot, INPUT_ROOT).split(sep).join("/"),
      sourceTreeBytesUnchanged: true,
      sha256MapPathPrefix: "source/",
      reason: "copyVerifiedSnapshot reads each hash-map key under sourceRoot; product source stays under source/ and the helper-compatible map keys include that prefix",
    },
  };
  const copyMetadataBytes = Buffer.from(`${JSON.stringify(copyMetadata, null, 2)}\n`);
  let outputCreated = false;
  try {
    await mkdir(OUTPUT_ROOT, { recursive: false, mode: 0o700 });
    outputCreated = true;
    const outputSource = resolve(OUTPUT_ROOT, "source");
    await mkdir(outputSource, { recursive: false, mode: 0o700 });
    for (const entry of actual) await writeReadonly(resolve(outputSource, entry.path), entry.bytes);
    for (const [name, bytes] of [
      ["freeze.json", freezeBytes],
      ["sha256.json", prefixedShaMapBytes],
      ["source-files.json", sourceFilesBytes],
      ["candidate-manifest.json", candidateManifestBytes],
      ["metadata.json", copyMetadataBytes],
      ["overlay.diff", overlayDiffBytes],
    ]) await writeReadonly(resolve(OUTPUT_ROOT, name), bytes);
    await freezeDirectories(outputSource);
    await freezeDirectories(OUTPUT_ROOT);

    const copied = await collectSource(outputSource);
    assert.deepEqual(copied.map(({ path, size, sha256: fileSha }) => ({ path, size, sha256: fileSha })), candidateManifest.files);
    assert.deepEqual(copied.map(({ path, sha256: fileSha }) => [`source/${path}`, fileSha]), Object.entries(prefixedShaMap));
    return {
      status: "FROZEN_SOURCE_INPUTS_NOT_EXPORTED",
      candidateRoot: OUTPUT_ROOT,
      candidateSourceRoot: outputSource,
      sourceDigest: EXPECTED_INPUT.sourceDigest,
      sourceFiles: EXPECTED_INPUT.count,
      sourceFilesSha256: sha256(sourceFilesBytes),
      candidateManifestSha256: sha256(candidateManifestBytes),
      metadataSha256: sha256(copyMetadataBytes),
      sha256MapSha256: sha256(prefixedShaMapBytes),
      sourceTreeUnchangedFrom: relative(repoRoot, INPUT_ROOT).split(sep).join("/"),
      sha256MapKeyPrefix: "source/",
      exportStatus: "not-run",
      browserStatus: "not-run",
    };
  } catch (error) {
    if (outputCreated) await rm(OUTPUT_ROOT, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

main().then(result => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch(error => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
});
