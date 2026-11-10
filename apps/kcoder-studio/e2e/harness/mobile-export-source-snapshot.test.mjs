import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { inspectMobileWebExportSourceIdentity } from "./mobile-web-export-archive.mjs";
import {
  captureMobileExportSourceSnapshot,
  createMobileSessionCacheSourceSnapshotManifest,
  verifyMobileExportSourceSnapshot,
} from "./mobile-export-source-snapshot.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const jsonHash = value => hash(JSON.stringify(value));
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "kc-source-evidence-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoots = [
    { name: "mobile", path: join(base, "mobile"), destination: "apps/kcoder-studio/mobile" },
    { name: "studio-shared", path: join(base, "shared"), destination: "apps/kcoder-studio/shared" },
  ];
  const originals = [
    { root: "mobile", path: ".env.example", bytes: "EXAMPLE=placeholder\n" },
    { root: "mobile", path: "src/app/index.tsx", bytes: "export default 1;\n" },
    { root: "mobile", path: "src/terminal-webview/generated-html.ts", bytes: "original generated input\n" },
    { root: "studio-shared", path: "types.ts", bytes: "export type A = string;\n" },
  ];
  const write = async (root, path, bytes) => {
    const destination = join(sourceRoots.find(row => row.name === root).path, path);
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes);
  };
  for (const row of originals) await write(row.root, row.path, row.bytes);
  for (const path of [".env", ".env.local", "config.credentials.json", "src/storage/device-secret-binding.test.ts", "node_modules/pkg/index.js", "dist/output.js", ".git/HEAD", ".expo/cache"])
    await write("mobile", path, "EXCLUDED PRIVATE SENTINEL");
  const roots = sourceRoots.map(root => {
    const table = originals.filter(row => row.root === root.name).map(row => ({ path: row.path,
      size: Buffer.byteLength(row.bytes), sha256: hash(row.bytes) })).sort((a, b) => a.path.localeCompare(b.path));
    return { name: root.name, sourceRoot: root.path, destination: root.destination, sha256: jsonHash(table), fileCount: table.length };
  });
  const sourceTreeSha256 = jsonHash(roots.map(({ name, destination, sha256 }) => ({ name, destination, sha256 })));
  const exported = { sourceRoots: roots, sourceTreeSha256, buildInputTreeSha256: sourceTreeSha256 };
  const exporterManifest = { status: "complete", inputRoots: roots, inputRootsAfter: roots,
    sourceUnchanged: true, snapshotCopyMatchesSource: true };
  for (const key of ["sourceTreeSha256", "sourceHashBefore", "sourceHashAfter", "buildInputTreeBeforeCopySha256", "buildInputTreeAfterCopySha256"])
    exporterManifest[key] = sourceTreeSha256;
  const f = { sourceRoots, snapshotRoot: join(base, "snapshot"), exported, exporterManifest, write, originals };
  f.capture = () => captureMobileExportSourceSnapshot(f);
  f.verify = snapshot => verifyMobileExportSourceSnapshot({ ...f, snapshot });
  return f;
}

test("snapshot retains every allowed original byte and matches independent exporter root tables", async t => {
  const f = await fixture(t), snapshot = await f.capture();
  assert.equal(snapshot.fileCount, 4); assert.equal(snapshot.exclusions.length, 8);
  assert.equal("layout" in snapshot, false);
  assert.deepEqual(snapshot.roots, f.exported.sourceRoots);
  assert.equal(snapshot.sourceTreeSha256, f.exported.sourceTreeSha256);
  for (const row of f.originals) assert.equal(await readFile(join(f.snapshotRoot, row.root, row.path), "utf8"), row.bytes);
  assert.ok(!JSON.stringify(snapshot.files).includes("device-secret"));
  assert.equal((await f.verify(snapshot)).status, "PASS_ORIGINAL_COPY_EXPORT_SOURCE_MATCH");
});

test("preflight layout preserves the archive file table and private snapshot modes", async t => {
  const f = await fixture(t);
  const snapshot = await captureMobileExportSourceSnapshot({
    ...f, layout: "preflight-source-root", freezeFiles: true,
  });
  const head = "a".repeat(40);
  const manifest = createMobileSessionCacheSourceSnapshotManifest({ snapshot, snapshotRoot: f.snapshotRoot, head });
  assert.equal(manifest.sourceRoot, f.snapshotRoot);
  assert.equal(manifest.mobileRoot, join(f.snapshotRoot, "apps/kcoder-studio/mobile"));
  assert.equal(manifest.sharedRoot, join(f.snapshotRoot, "apps/kcoder-studio/shared"));
  assert.equal(manifest.head, head);
  assert.deepEqual(manifest.files, f.originals.map(row => ({
    path: `apps/kcoder-studio/${row.root === "mobile" ? "mobile" : "shared"}/${row.path}`,
    bytes: Buffer.byteLength(row.bytes), sha256: hash(row.bytes),
  })).sort((left, right) => left.path.localeCompare(right.path)));
  const manifestPath = join(dirname(f.snapshotRoot), "compat-manifest.json");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  const identity = await inspectMobileWebExportSourceIdentity({
    sourceRoots: [
      { name: "mobile", sourceRoot: manifest.mobileRoot, destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", sourceRoot: manifest.sharedRoot, destination: "apps/kcoder-studio/shared" },
    ],
    snapshotManifestPath: manifestPath,
    expectedSnapshotManifestSha256: hash(manifestBytes),
  });
  assert.equal(identity.snapshotProof.manifestSha256, hash(manifestBytes));
  assert.equal(identity.snapshotProof.head, head);
  for (const path of [
    f.snapshotRoot,
    join(f.snapshotRoot, "apps"),
    join(f.snapshotRoot, "apps/kcoder-studio"),
    join(f.snapshotRoot, "apps/kcoder-studio/mobile"),
    join(f.snapshotRoot, "apps/kcoder-studio/shared"),
  ]) assert.equal((await lstat(path)).mode & 0o777, 0o700);
  for (const row of f.originals) {
    const root = row.root === "mobile" ? "mobile" : "shared";
    const path = join(f.snapshotRoot, "apps/kcoder-studio", root, row.path);
    assert.equal((await lstat(path)).mode & 0o777, 0o400);
    assert.equal(await readFile(path, "utf8"), row.bytes);
  }
  const unsafe = structuredClone(snapshot);
  unsafe.files[0].path = "../escape";
  assert.throws(() => createMobileSessionCacheSourceSnapshotManifest({ snapshot: unsafe, snapshotRoot: f.snapshotRoot, head }), /unsafe source path component/);
});

test("preflight layout creates nested roots when file freezing is disabled and remains verifiable", async t => {
  const f = await fixture(t);
  const snapshotRoot = join(dirname(f.snapshotRoot), "unfrozen-source-root");
  const snapshot = await captureMobileExportSourceSnapshot({
    ...f, snapshotRoot,
    layout: "preflight-source-root", freezeFiles: false,
  });
  assert.equal(snapshot.layout, "preflight-source-root");
  const mobilePath = join(snapshotRoot, "apps/kcoder-studio/mobile/src/app/index.tsx");
  assert.equal((await lstat(mobilePath)).mode & 0o777, 0o600);
  assert.equal((await lstat(snapshotRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(snapshotRoot, "apps/kcoder-studio"))).mode & 0o777, 0o700);
  assert.equal((await verifyMobileExportSourceSnapshot({
    snapshot, snapshotRoot, sourceRoots: f.sourceRoots, exported: f.exported, exporterManifest: f.exporterManifest,
  })).status, "PASS_ORIGINAL_COPY_EXPORT_SOURCE_MATCH");
});

test("post-terminal generated output cannot replace the original source evidence", async t => {
  const f = await fixture(t), snapshot = await f.capture();
  await f.write("mobile", "src/terminal-webview/generated-html.ts", "terminal hook changed output");
  await assert.rejects(f.verify(snapshot), /original source changed/);
  assert.equal(await readFile(join(f.snapshotRoot, "mobile", "src/terminal-webview/generated-html.ts"), "utf8"), "original generated input\n");
});

test("snapshot detects source additions and copy mutation or unlisted excluded files", async t => {
  const f = await fixture(t), snapshot = await f.capture();
  await f.write("studio-shared", "new.ts", "new source");
  await assert.rejects(f.verify(snapshot), /original source changed/);
  await rm(join(f.sourceRoots[1].path, "new.ts"));
  const copied = join(f.snapshotRoot, "studio-shared", "types.ts");
  await writeFile(copied, "modified copy");
  await assert.rejects(f.verify(snapshot), /snapshot file bytes/);
  await writeFile(copied, f.originals.at(-1).bytes);
  await writeFile(join(f.snapshotRoot, "mobile", ".env"), "must not be archived");
  await assert.rejects(f.verify(snapshot), /only allowed source/);
});

test("exporter mismatched roots/count/aggregate or weakened source/copy gates reject", async t => {
  const f = await fixture(t), snapshot = await f.capture();
  for (const mutate of [
    value => { value.exported.sourceRoots[0].sha256 = "0".repeat(64); },
    value => { value.exporterManifest.inputRootsAfter[0].fileCount++; },
    value => { value.exported.sourceTreeSha256 = "0".repeat(64); },
    value => { value.exporterManifest.sourceUnchanged = false; },
    value => { value.exporterManifest.snapshotCopyMatchesSource = false; },
    value => { value.exporterManifest.buildInputTreeAfterCopySha256 = "0".repeat(64); },
  ]) {
    const params = structuredClone({ exported: f.exported, exporterManifest: f.exporterManifest }); mutate(params);
    await assert.rejects(verifyMobileExportSourceSnapshot({ ...f, ...params, snapshot }));
  }
});

test("source symlink is rejected without copying its target", async t => {
  const f = await fixture(t);
  await symlink(join(f.sourceRoots[1].path, "types.ts"), join(f.sourceRoots[0].path, "linked.ts"));
  await assert.rejects(f.capture(), /symlink/);
});

test("fresh snapshot cannot overwrite artifacts or be nested inside source", async t => {
  const f = await fixture(t); await mkdir(f.snapshotRoot);
  await assert.rejects(f.capture(), /EEXIST/);
  await assert.rejects(captureMobileExportSourceSnapshot({ ...f, snapshotRoot: join(f.sourceRoots[0].path, "evidence") }), /inside input/);
});

test("oversized source and noncanonical root/destination reject before accepting evidence", async t => {
  const f = await fixture(t), file = join(f.sourceRoots[0].path, "oversized.ts");
  await writeFile(file, ""); await truncate(file, 16 * 1024 * 1024 + 1);
  await assert.rejects(f.capture(), /source file exceeds bound/);
  for (const layout of ["flat", "preflight-source-root"]) {
    await assert.rejects(captureMobileExportSourceSnapshot({
      ...f, layout, snapshotRoot: join(dirname(f.snapshotRoot), `unsafe-${layout}`),
      sourceRoots: [{ ...f.sourceRoots[0], destination: "../escape" }, f.sourceRoots[1]],
    }));
  }
  await assert.rejects(captureMobileExportSourceSnapshot({ ...f, layout: "../escape" }), /unsupported Mobile export source snapshot layout/);
});
