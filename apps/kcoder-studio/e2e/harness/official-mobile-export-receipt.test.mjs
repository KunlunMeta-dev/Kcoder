import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { addOfficialMobileExportPostflight, officialMobileExportReceiptFromEnv, readOfficialMobileExportReceipt, verifyOfficialMobileSourceSnapshot } from "./official-mobile-export-receipt.mjs";

import { RunContext } from "./run-context.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const mobile = "apps/kcoder-studio/mobile";
const shared = "apps/kcoder-studio/shared";
const approvedSnapshot = "target/private-official-export-receipt-wiring-20261009/source-adapter-9925461c";

const snapshotOptions = (f, sourceSnapshotManifestSha256 = f.snapshotManifestSha256, sourceSnapshotRoot = f.snapshot) => ({
  repoRoot: f.root,
  sourceSnapshotRoot,
  sourceSnapshotManifestSha256,
});

test("no receipt preserves legacy input; partial or unpinned input is rejected", () => {
  assert.equal(officialMobileExportReceiptFromEnv({}), null);
  assert.throws(() => officialMobileExportReceiptFromEnv({ KCODER_E2E_OFFICIAL_EXPORT_RECEIPT: "/tmp/receipt.json" }));
  assert.throws(() => officialMobileExportReceiptFromEnv({ KCODER_E2E_OFFICIAL_EXPORT_RECEIPT: "relative", KCODER_E2E_OFFICIAL_EXPORT_RECEIPT_SHA256: "a".repeat(64), KCODER_E2E_OFFICIAL_EXPORT_RUN_MANIFEST_SHA256: "b".repeat(64) }));
});

test("completed receipt binds official 37/38 bytes and allows later unrelated HEAD commit", async () => {
  await fixture(async f => {
    await f.write("unrelated.txt", "later harness change"); f.git("add", "unrelated.txt"); f.git("commit", "-qm", "unrelated");
    const actual = await readOfficialMobileExportReceipt(f.input, { repoRoot: f.root });
    assert.equal(actual.builderCommit, f.receipt.source.commit);
    assert.equal(actual.builderSourceProvenance.mode, "currentTreeParity");
    assert.notEqual(actual.builderSourceParity.currentHead, actual.builderCommit);
    assert.equal(actual.sourceDist.resourceCount, 37);
    assert.equal((await verifyOfficialMobileSourceSnapshot(f.snapshot, actual.builderCommit, { repoRoot: f.root })).verifiedGitBlobs, 3);
  });
});

test("approved immutable Git snapshot accepts dirty live source and stays explicit through postflight", async () => {
  await fixture(async f => {
    await f.write(`${mobile}/index.ts`, "live source changed after official Git export");
    const options = snapshotOptions(f);
    const actual = await readOfficialMobileExportReceipt(f.input, options);
    assert.equal(actual.builderSourceProvenance.mode, "immutableSnapshot");
    assert.equal(actual.builderSourceProvenance.sourceSnapshotPath, approvedSnapshot);
    assert.equal(actual.builderSourceProvenance.sourceSnapshotManifestSha256, f.snapshotManifestSha256);
    assert.equal(actual.builderSourceProvenance.verifiedGitBlobs, 3);
    assert.equal(actual.builderSourceParity, null);
    assert.equal("currentHead" in actual.builderSourceProvenance, false);

    let postflight;
    const context = { addCleanup(label, callback) { assert.equal(label, "verify completed official export input after run"); postflight = callback; } };
    addOfficialMobileExportPostflight(context, f.input, actual, options);
    await f.write(`${mobile}/index.ts`, "live source changed again before postflight");
    await postflight();
  });
});

test("immutable snapshot mode requires the pinned approved root and manifest", async () => {
  await fixture(async f => {
    await assert.rejects(readOfficialMobileExportReceipt(f.input, {
      repoRoot: f.root,
      sourceSnapshotRoot: f.snapshot,
    }));
    await assert.rejects(readOfficialMobileExportReceipt(f.input, snapshotOptions(f, f.snapshotManifestSha256, join(f.root, "snapshot"))), /approved Git 992 snapshot/);
  });
});

test("immutable snapshot rejects a blob mismatch even when its local hash manifest is repinned", async () => {
  await fixture(async f => {
    const path = `${mobile}/index.ts`;
    await writeFile(join(f.snapshot, path), "wrong Git blob");
    const hashes = await f.readSnapshotHashes(); hashes[path] = hash("wrong Git blob");
    const pin = await f.writeSnapshotHashes(hashes);
    await assert.rejects(readOfficialMobileExportReceipt(f.input, snapshotOptions(f, pin)), /differs from official export commit/);
  });
});

test("immutable snapshot rejects a missing scoped file", async () => {
  await fixture(async f => {
    await rm(join(f.snapshot, `${mobile}/index.ts`));
    await assert.rejects(readOfficialMobileExportReceipt(f.input, snapshotOptions(f)), /ENOENT/);
  });
});

test("immutable snapshot rejects extra scoped files and hash entries", async () => {
  await fixture(async f => {
    await writeFile(join(f.snapshot, mobile, "extra.ts"), "extra source file");
    await assert.rejects(readOfficialMobileExportReceipt(f.input, snapshotOptions(f)), /file set differs from official Git inventory/);
  });
  await fixture(async f => {
    const hashes = await f.readSnapshotHashes(); hashes[`${mobile}/extra.ts`] = hash("extra source file");
    const pin = await f.writeSnapshotHashes(hashes);
    await assert.rejects(readOfficialMobileExportReceipt(f.input, snapshotOptions(f, pin)), /hash manifest differs from official Git inventory/);
  });
});

test("immutable snapshot rejects content hash drift and a changed manifest without its pin", async () => {
  await fixture(async f => {
    const hashes = await f.readSnapshotHashes(); hashes[`${mobile}/index.ts`] = "0".repeat(64);
    const pin = await f.writeSnapshotHashes(hashes);
    await assert.rejects(readOfficialMobileExportReceipt(f.input, snapshotOptions(f, pin)), /source adapter hash mismatch/);
  });
  await fixture(async f => {
    const path = join(f.snapshot, "sha256.json");
    await writeFile(path, `${await readFile(path, "utf8")} `);
    await assert.rejects(readOfficialMobileExportReceipt(f.input, snapshotOptions(f)), /evidence SHA changed/);
  });
});

test("explicit receipt SHA rejects changed receipt before trusting its fields", async () => {
  await fixture(async f => {
    await writeFile(f.input.receiptPath, JSON.stringify({ ...f.receipt, exportPerformedOnce: false }));
    await assert.rejects(readOfficialMobileExportReceipt(f.input, { repoRoot: f.root }), /evidence SHA changed/);
  });
});

test("a pinned but failed or incompletely cleaned export is rejected", async () => {
  await fixture(async f => {
    for (const changed of [{ status: "failed" }, { processes: [{ stopped: false, spawnError: null }] }, { cleanupSteps: [{ status: "failed" }] }]) {
      const bytes = Buffer.from(JSON.stringify({ ...f.runManifest, ...changed }));
      await writeFile(join(f.runRoot, "manifest.json"), bytes);
      await assert.rejects(readOfficialMobileExportReceipt({ ...f.input, runManifestSha256: hash(bytes) }, { repoRoot: f.root }));
    }
  });
});

test("current scoped source drift and wrong lock pin cannot reuse old build", async () => {
  await fixture(async f => {
    await f.write(`${mobile}/index.ts`, "changed");
    await assert.rejects(readOfficialMobileExportReceipt(f.input, { repoRoot: f.root }));
    f.git("checkout", "--", `${mobile}/index.ts`);
    f.receipt.source.packageLockSha256 = "0".repeat(64);
    await f.refreshReceipt();
    await assert.rejects(readOfficialMobileExportReceipt(f.input, { repoRoot: f.root }));
  });
});

test("existing dist verifier rejects modified asset and extra physical file", async () => {
  await fixture(async f => {
    const path = join(f.distRoot, "index.html"); const bytes = await readFile(path);
    await writeFile(path, "corrupt");
    await assert.rejects(readOfficialMobileExportReceipt(f.input, { repoRoot: f.root }));
    await writeFile(path, bytes); await writeFile(join(f.distRoot, "extra.bin"), "extra");
    await assert.rejects(readOfficialMobileExportReceipt(f.input, { repoRoot: f.root }), /file set differs/);
  });
});

test("Home adapter must contain exact Git scoped files, not just matching self hashes", async () => {
  await fixture(async f => {
    await writeFile(join(f.snapshot, mobile, "index.ts"), "stale");
    const hashes = JSON.parse(await readFile(join(f.snapshot, "sha256.json")));
    hashes[`${mobile}/index.ts`] = hash("stale"); await writeFile(join(f.snapshot, "sha256.json"), JSON.stringify(hashes));
    await assert.rejects(verifyOfficialMobileSourceSnapshot(f.snapshot, f.receipt.source.commit, { repoRoot: f.root }), /differs from official export commit/);
  });
});

test("RunContext result must agree with separately pinned receipt", async () => {
  await fixture(async f => {
    await writeFile(join(f.runRoot, "artifacts/result.json"), JSON.stringify({ status: "passed", testId: f.runManifest.testId, result: {} }));
    await assert.rejects(readOfficialMobileExportReceipt(f.input, { repoRoot: f.root }));
  });
});

test("receipt postflight completes after owned cleanup while RunContext is finishing", async () => {
  await fixture(async f => {
    const before = await readOfficialMobileExportReceipt(f.input, { repoRoot: f.root });
    const context = await RunContext.create(import.meta.url, { testId: "official-receipt-cleanup-order" });
    const events = [];
    addOfficialMobileExportPostflight(context, f.input, before, { repoRoot: f.root });
    context.addCleanup("owned resource is stopped before receipt postflight", () => {
      assert.equal(context.finishing, true);
      events.push("owned-stopped");
    });
    await context.finish("passed", { noBrowser: true });
    const manifest = JSON.parse(await readFile(join(context.runRoot, "manifest.json")));
    assert.equal(manifest.status, "passed");
    assert.deepEqual(events, ["owned-stopped"]);
    assert.deepEqual(manifest.cleanupSteps.map(row => [row.label, row.status]), [
      ["owned resource is stopped before receipt postflight", "completed"],
      ["verify completed official export input after run", "completed"],
    ]);
  });
});

for (const changed of ["source", "resource"]) {
  test(`receipt postflight rejects ${changed} drift during actual RunContext cleanup`, async () => {
    await fixture(async f => {
      const before = await readOfficialMobileExportReceipt(f.input, { repoRoot: f.root });
      const context = await RunContext.create(import.meta.url, { testId: `official-receipt-cleanup-${changed}-drift` });
      addOfficialMobileExportPostflight(context, f.input, before, { repoRoot: f.root });
      context.addCleanup("owned resource shutdown changes input", async () => {
        assert.equal(context.finishing, true);
        if (changed === "source") await f.write(`${mobile}/index.ts`, "late source drift");
        else await writeFile(join(f.distRoot, "index.html"), "late resource drift");
      });
      await assert.rejects(context.finish("passed", { noBrowser: true }));
      const manifest = JSON.parse(await readFile(join(context.runRoot, "manifest.json")));
      assert.equal(manifest.status, "failed");
      assert.deepEqual(manifest.cleanupSteps.map(row => row.status), ["completed", "failed"]);
      assert.doesNotMatch(manifest.error, /finishing or already finished/);
    });
  });
}

async function fixture(body) {
  const root = await mkdtemp(join(tmpdir(), "official-receipt-contract-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const write = async (path, bytes) => { await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 }); await writeFile(join(root, path), bytes, { mode: 0o600 }); };
    git("init", "-q"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@invalid.local");
    const sourceFiles = { [`${mobile}/index.ts`]: "mobile", [`${mobile}/package-lock.json`]: "{}", [`${shared}/index.ts`]: "shared" };
    for (const [path, bytes] of Object.entries(sourceFiles)) await write(path, bytes);
    git("add", "apps"); git("commit", "-qm", "source"); const commit = git("rev-parse", "HEAD"); const short = commit.slice(0, 8);
    const runRoot = join(root, "target/test/apps/kcoder-studio/e2e/private", `mobile-web-export-${short}.once.e2e.mjs`, "run");
    const distRel = `artifacts/official-mobile-dist-${short}`; const distRoot = join(runRoot, distRel); await mkdir(distRoot, { recursive: true, mode: 0o700 });
    const files = [];
    for (let i = 0; i < 37; i++) {
      const path = i === 0 ? "index.html" : `asset-${i}.bin`; const bytes = Buffer.from(`resource-${i}`);
      await writeFile(join(distRoot, path), bytes, { mode: 0o600 }); files.push({ path, size: bytes.length, sha256: hash(bytes), text: false, replacements: 0 });
    }
    const json = async (path, value) => { const bytes = Buffer.from(JSON.stringify(value)); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 }); return hash(bytes); };
    const manifestSha256 = await json(join(distRoot, "kcoder-mobile-web.json"), { version: 1, baseToken: "/__kcoder_mobile_mount_v1__", files });
    const table = files.map(({ path, size, sha256 }) => ({ path, size, sha256 })); const bundleSha256 = hash(JSON.stringify(table));
    const source = { commit, mobileTree: git("rev-parse", `${commit}:${mobile}`), sharedTree: git("rev-parse", `${commit}:${shared}`), packageLockSha256: hash("{}"), sourceTreeSha256: hash("fixture tree"), sourceUnchangedOutsideGeneratedHtml: true };
    source.freezeManifestSha256 = await json(join(runRoot, `artifacts/source-freeze-${short}.json`), { sourceCommit: commit, mobilePackageLockSha256: source.packageLockSha256, sourceRoots: [{ path: mobile, gitTree: source.mobileTree }, { path: shared, gitTree: source.sharedTree }] });
    const reusePath = `artifacts/mobile-web-export-reuse-manifest-${short}.json`;
    const reuseSha = await json(join(runRoot, reusePath), { sourceCommit: commit, sourceTreeSha256: source.sourceTreeSha256, bundleSha256, bundleFileCount: 37, files: table });
    const receipt = { source, dependencies: { sourceUnchanged: true, sourceTreeSha256Before: hash("deps"), sourceTreeSha256After: hash("deps") }, officialDeployment: { directory: distRel, manifestPath: `${distRel}/kcoder-mobile-web.json`, manifestSha256, resourceCount: 37, physicalFileCount: 38, bundleSha256, indexHtmlSha256: files[0].sha256 }, reuseInput: { manifestPath: reusePath, manifestSha256: reuseSha, bundleSha256 }, exportPerformedOnce: true, sourceSnapshotFromGitArchive: true };
    const runManifest = { status: "passed", error: null, endedAt: "2026-10-09T18:00:00Z", source: `apps/kcoder-studio/e2e/private/mobile-web-export-${short}.once.e2e.mjs`, testId: "fixture", processes: [{ stopped: true, spawnError: null }], cleanupSteps: [{ status: "completed" }], ports: [] };
    const input = { receiptPath: join(runRoot, `artifacts/official-mobile-web-export-${short}.json`), receiptSha256: null, runManifestSha256: await json(join(runRoot, "manifest.json"), runManifest) };
    const refreshReceipt = async () => { input.receiptSha256 = await json(input.receiptPath, receipt); await json(join(runRoot, "artifacts/result.json"), { status: "passed", testId: runManifest.testId, result: receipt }); }; await refreshReceipt();
    const snapshot = join(root, approvedSnapshot); const hashes = {};
    for (const [path, bytes] of Object.entries(sourceFiles)) { await mkdir(dirname(join(snapshot, path)), { recursive: true, mode: 0o700 }); await writeFile(join(snapshot, path), bytes, { mode: 0o600 }); hashes[path] = hash(bytes); }
    const snapshotManifestSha256 = await json(join(snapshot, "sha256.json"), hashes);
    const readSnapshotHashes = async () => JSON.parse(await readFile(join(snapshot, "sha256.json"), "utf8"));
    const writeSnapshotHashes = async value => json(join(snapshot, "sha256.json"), value);
    await body({ root, git, write, runRoot, distRoot, receipt, runManifest, input, snapshot, snapshotManifestSha256, readSnapshotHashes, writeSnapshotHashes, refreshReceipt });
  } finally { await rm(root, { recursive: true, force: true }); }
}
