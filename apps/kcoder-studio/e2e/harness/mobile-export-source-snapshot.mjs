import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { shouldOmitMobileSourceEntry as excluded } from './mobile-source-policy.mjs';

const ROOTS = [
  { name: "mobile", destination: "apps/kcoder-studio/mobile" },
  { name: "studio-shared", destination: "apps/kcoder-studio/shared" },
];
const SNAPSHOT_LAYOUTS = new Set(["flat", "preflight-source-root"]);
const MAX_FILES = 4096, MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_BYTES = 64 * 1024 * 1024;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const hashJson = value => sha256(JSON.stringify(value));
const projection = roots => roots.map(({ name, sourceRoot, destination, sha256, fileCount }) =>
  ({ name, sourceRoot, destination, sha256, fileCount }));

function safePart(name) {
  assert.ok(name && name !== "." && name !== ".." && !/[\\/\0]/.test(name), "unsafe source path component");
}
async function directory(path) {
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), "source directory must be regular and not a symlink");
  assert.equal(await realpath(path), path, "source directory cannot traverse a symlink");
  return info;
}
async function rootsFor(sourceRoots) {
  assert.equal(sourceRoots.length, ROOTS.length);
  const roots = [];
  for (const [index, expected] of ROOTS.entries()) {
    const root = sourceRoots[index];
    assert.equal(root.name, expected.name); assert.equal(root.destination, expected.destination);
    const path = resolve(root.path);
    await directory(path);
    roots.push({ ...expected, path });
  }
  assert.equal(roots[1].path, resolve(roots[0].path, "../shared"), "Shared must be Mobile's sibling");
  return roots;
}
async function fileBytes(path, expected) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    assert.ok(before.isFile(), "source must be a regular file");
    assert.equal(before.dev, expected.dev); assert.equal(before.ino, expected.ino);
    assert.ok(before.size <= MAX_FILE_BYTES, "source file exceeds bound");
    const bytes = await handle.readFile();
    const after = await handle.stat(), current = await lstat(path);
    for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) assert.equal(after[key], before[key], "source changed during read");
    assert.equal(current.dev, before.dev); assert.equal(current.ino, before.ino);
    assert.equal(bytes.length, before.size);
    return bytes;
  } finally { await handle.close(); }
}
async function collect(roots, onFile = async () => {}) {
  const files = [], exclusions = [], described = [];
  let byteCount = 0, visited = 0;
  for (const root of roots) {
    const table = [];
    async function visit(path, prefix = "") {
      const before = await directory(path);
      for (const child of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        assert.ok(++visited <= MAX_FILES * 4, "source entry count exceeds bound");
        safePart(child.name);
        const relative = prefix ? `${prefix}/${child.name}` : child.name;
        if (excluded(child.name, relative, child.isDirectory())) { exclusions.push({ root: root.name, path: relative }); continue; }
        const absolute = resolve(path, child.name), info = await lstat(absolute);
        assert.ok(!info.isSymbolicLink(), "source contains a symlink");
        if (info.isDirectory()) await visit(absolute, relative);
        else {
          assert.ok(info.isFile(), "source contains a special file");
          assert.ok(files.length < MAX_FILES, "source file count exceeds bound");
          assert.ok(byteCount + info.size <= MAX_BYTES, "source byte count exceeds bound");
          const bytes = await fileBytes(absolute, info);
          byteCount += bytes.length;
          const row = { path: relative, size: bytes.length, sha256: sha256(bytes) };
          table.push(row); files.push({ root: root.name, ...row });
          await onFile(root, row, bytes);
        }
      }
      const after = await directory(path);
      assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
    }
    await visit(root.path);
    table.sort((a, b) => a.path.localeCompare(b.path));
    described.push({ name: root.name, sourceRoot: root.path, destination: root.destination,
      sha256: hashJson(table), fileCount: table.length });
  }
  files.sort((a, b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path));
  exclusions.sort((a, b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path));
  return { roots: described, files, exclusions, fileCount: files.length, byteCount,
    sourceTreeSha256: hashJson(described.map(({ name, destination, sha256 }) => ({ name, destination, sha256 }))) };
}
function snapshotRootParts(root, layout) {
  assert.ok(SNAPSHOT_LAYOUTS.has(layout), "unsupported Mobile export source snapshot layout");
  const parts = (layout === "flat" ? root.name : root.destination).split("/");
  for (const part of parts) safePart(part);
  assert.ok(parts.length > 0 && parts.every(part => part !== "." && part !== ".."), "unsafe snapshot destination path");
  return parts;
}

async function createSnapshotDirectories(snapshotRoot, parts) {
  let current = snapshotRoot;
  for (const part of parts) {
    safePart(part);
    const next = resolve(current, part);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await directory(next);
    await chmod(next, 0o700);
    assert.equal(info.isDirectory(), true);
    current = next;
  }
  return current;
}

function copyRoots(snapshotRoot, layout = "flat") {
  return ROOTS.map(root => ({ ...root, path: resolve(snapshotRoot, ...snapshotRootParts(root, layout)) }));
}
async function verifyCopy(snapshot, snapshotRoot, layout = "flat") {
  const copied = await collect(copyRoots(snapshotRoot, layout));
  assert.deepEqual(copied.files, snapshot.files, "snapshot file bytes/set changed");
  assert.deepEqual(copied.exclusions, [], "snapshot must contain only allowed source files");
  assert.equal(copied.sourceTreeSha256, snapshot.sourceTreeSha256);
}

/** Retain only original build inputs as data, before the terminal hook changes its owned copy. */
export async function captureMobileExportSourceSnapshot({
  sourceRoots, snapshotRoot, layout = "flat", freezeFiles = false,
}) {
  assert.ok(SNAPSHOT_LAYOUTS.has(layout), "unsupported Mobile export source snapshot layout");
  assert.equal(typeof freezeFiles, "boolean", "freezeFiles must be boolean");
  if (freezeFiles) assert.equal(layout, "preflight-source-root", "only the preflight source-root layout may freeze copied files");
  const roots = await rootsFor(sourceRoots);
  snapshotRoot = resolve(snapshotRoot);
  const parent = await realpath(dirname(snapshotRoot));
  assert.equal(parent, dirname(snapshotRoot), "snapshot parent must not traverse symlinks");
  for (const root of roots) assert.ok(snapshotRoot !== root.path && !snapshotRoot.startsWith(`${root.path}${sep}`), "snapshot cannot be inside input roots");
  await mkdir(snapshotRoot, { mode: 0o700 }); // A pre-existing artifact is never overwritten.
  if (layout === "preflight-source-root") {
    await chmod(snapshotRoot, 0o700);
    await directory(snapshotRoot);
  }
  for (const root of ROOTS) {
    if (layout === "preflight-source-root") await createSnapshotDirectories(snapshotRoot, snapshotRootParts(root, layout));
    else await mkdir(resolve(snapshotRoot, ...snapshotRootParts(root, layout)), { mode: 0o700 });
  }
  const snapshot = await collect(roots, async (root, row, bytes) => {
    const parts = [...snapshotRootParts(root, layout), ...row.path.split("/")];
    for (const part of parts.slice(snapshotRootParts(root, layout).length)) safePart(part);
    const destination = resolve(snapshotRoot, ...parts);
    if (layout === "preflight-source-root") await createSnapshotDirectories(snapshotRoot, parts.slice(0, -1));
    else await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    assert.equal(sha256(await readFile(destination)), row.sha256, "source copy hash mismatch");
    if (freezeFiles) {
      const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        assert.ok(info.isFile(), "snapshot copy must be a regular file");
        await handle.chmod(0o400);
      } finally { await handle.close(); }
    }
  });
  assert.deepEqual(await collect(roots), snapshot, "original source changed while capturing snapshot");
  await verifyCopy(snapshot, snapshotRoot, layout);
  return { schemaVersion: 1, kind: "mobile-export-original-source-snapshot", ...snapshot,
    ...(layout === "flat" ? {} : { layout }),
    exclusionPolicy: "mobile-web-export.mjs shouldOmitSourceEntry; excluded directories are not traversed",
    snapshotDirectory: layout === "flat" ? "source-snapshot" : ".",
    evidenceClass: "original build-input bytes; not post-terminal generated source or runtime execution" };
}

/** Map a captured source-root layout to the existing archive inspector's compatibility manifest. */
export function createMobileSessionCacheSourceSnapshotManifest({ snapshot, snapshotRoot, head }) {
  assert.ok(snapshot && snapshot.kind === "mobile-export-original-source-snapshot", "original source snapshot is required");
  assert.equal(snapshot.layout, "preflight-source-root", "compatibility manifest requires the preflight source-root layout");
  assert.equal(resolve(snapshotRoot), snapshotRoot, "snapshot root must be absolute and normalized");
  assert.match(head ?? "", /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/, "git HEAD baseline must be a full commit SHA");
  assert.ok(Array.isArray(snapshot.files) && snapshot.files.length > 0 && snapshot.files.length <= MAX_FILES,
    "source snapshot file table is outside its bound");
  const files = snapshot.files.map(row => {
    const root = ROOTS.find(candidate => candidate.name === row.root);
    assert.ok(root, "source snapshot contains an unknown root");
    assert.ok(typeof row.path === "string" && row.path.length > 0 && !row.path.startsWith("/"), "source snapshot path must be relative");
    for (const part of row.path.split("/")) safePart(part);
    assert.ok(Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= MAX_FILE_BYTES, "source snapshot file size is invalid");
    assert.match(row.sha256 ?? "", /^[a-f0-9]{64}$/, "source snapshot file SHA-256 is invalid");
    return { path: `${root.destination}/${row.path}`, bytes: row.size, sha256: row.sha256 };
  }).sort((left, right) => left.path.localeCompare(right.path));
  assert.equal(new Set(files.map(row => row.path)).size, files.length, "source snapshot has duplicate archive paths");
  return {
    kind: "owned-readonly-p1-mobile-and-shared-input",
    sourceRoot: snapshotRoot,
    mobileRoot: resolve(snapshotRoot, ...ROOTS[0].destination.split("/")),
    sharedRoot: resolve(snapshotRoot, ...ROOTS[1].destination.split("/")),
    head,
    files,
  };
}

/** Compare original/copy after export and require the exporter's independent root and copy gates. */
export async function verifyMobileExportSourceSnapshot({ snapshot, snapshotRoot, sourceRoots, exported, exporterManifest }) {
  const after = await collect(await rootsFor(sourceRoots));
  assert.deepEqual(after.files, snapshot.files, "original source changed after snapshot");
  assert.deepEqual(after.exclusions, snapshot.exclusions);
  assert.deepEqual(after.roots, snapshot.roots);
  await verifyCopy(snapshot, snapshotRoot, snapshot.layout ?? "flat");
  assert.deepEqual(projection(exported.sourceRoots), snapshot.roots, "exporter roots differ from original snapshot");
  assert.equal(exported.sourceTreeSha256, snapshot.sourceTreeSha256);
  assert.equal(exported.buildInputTreeSha256, snapshot.sourceTreeSha256);
  assert.equal(exporterManifest.status, "complete");
  assert.equal(exporterManifest.sourceUnchanged, true);
  assert.equal(exporterManifest.snapshotCopyMatchesSource, true);
  assert.deepEqual(projection(exporterManifest.inputRoots), snapshot.roots);
  assert.deepEqual(projection(exporterManifest.inputRootsAfter), snapshot.roots);
  for (const key of ["sourceTreeSha256", "sourceHashBefore", "sourceHashAfter", "buildInputTreeBeforeCopySha256", "buildInputTreeAfterCopySha256"])
    assert.equal(exporterManifest[key], snapshot.sourceTreeSha256, key);
  return { status: "PASS_ORIGINAL_COPY_EXPORT_SOURCE_MATCH", fileCount: snapshot.fileCount,
    byteCount: snapshot.byteCount, sourceTreeSha256: snapshot.sourceTreeSha256,
    originalBeforeAfterEqual: true, originalCopyEqual: true, exporterRootsEqual: true };
}
