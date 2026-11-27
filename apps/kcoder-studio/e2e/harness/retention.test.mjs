import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_RETENTION, enforceRetention, planRetention } from "./retention.mjs";

const removeAllCompleted = { maxRunsPerVariant: 0 };

test("retention keeps the latest outcome for each source and variant", () => {
  const runs = [
    { path: "/old", source: "a.mjs", status: "passed", endedAtMs: 1 },
    { path: "/failed", source: "a.mjs", status: "failed", endedAtMs: 2 },
    { path: "/passed", source: "a.mjs", status: "passed", endedAtMs: 3 },
    { path: "/newest", source: "a.mjs", status: "failed", endedAtMs: 4 },
    { path: "/peer", source: "b.mjs", status: "passed", endedAtMs: 0 },
  ];
  assert.equal(DEFAULT_RETENTION.maxRunsPerVariant, 1);
  assert.deepEqual(planRetention(runs).map(run => run.path), ["/old", "/failed", "/passed"]);
  assert.deepEqual(planRetention(runs, { maxRunsPerVariant: 3 }).map(run => run.path), ["/old"]);
});

test("old evidence remains when that test has not accumulated more runs", () => {
  assert.deepEqual(planRetention([
    { path: "/old-success", source: "a.mjs", variantId: "a", status: "passed", endedAtMs: 0 },
    { path: "/old-failure", source: "a.mjs", variantId: "b", status: "failed", endedAtMs: 1 },
  ]), []);
});

test("repeated runs stop accumulating without touching another test's data", async t => {
  await withFakeBoundary(t, async boundary => {
    const peer = join(boundary, "peer");
    await createCompletedRun(peer, { source: "peer.mjs" });
    for (let index = 0; index < 8; index++) {
      await createCompletedRun(join(boundary, `run-${index}`), { endedAt: new Date(index * 1000).toISOString(), status: index % 2 ? "passed" : "failed" });
      await enforceRetention(boundary);
      assert.equal((await readdir(boundary)).length, 2);
    }
    assert.deepEqual(await readdir(boundary), ["peer", "run-7"]);
  });
});

test("a frequently repeated variant cannot evict quieter variants or legacy default records", async t => {
  await withFakeBoundary(t, async boundary => {
    await createCompletedRun(join(boundary, "legacy-default"));
    await createCompletedRun(join(boundary, "quiet"), { variantId: "quiet" });
    for (let index = 0; index < 6; index++) {
      await createCompletedRun(join(boundary, `busy-${index}`), { variantId: "busy", endedAt: new Date(index * 1000).toISOString() });
      await enforceRetention(boundary);
    }
    assert.deepEqual(await readdir(boundary), ["busy-5", "legacy-default", "quiet"]);
    await createCompletedRun(join(boundary, "new-default"), { variantId: "default", endedAt: new Date(10_000).toISOString() });
    await enforceRetention(boundary);
    assert.deepEqual(await readdir(boundary), ["busy-5", "new-default", "quiet"]);
  });
});

test("missing, inconsistent, or invalid new receipts cannot evict completed evidence", async t => {
  for (const fault of ["missing-result", "mismatched-result", "invalid-variant"]) {
    await t.test(fault, subtest => withFakeBoundary(subtest, async boundary => {
      const previous = join(boundary, "previous"), current = join(boundary, "current");
      await createCompletedRun(previous);
      await createCompletedRun(current, { endedAt: new Date(10_000).toISOString(), ...(fault === "invalid-variant" ? { variantId: "../unsafe" } : {}) });
      if (fault === "missing-result") await rm(join(current, "artifacts/result.json"));
      if (fault === "mismatched-result") await writeFile(join(current, "artifacts/result.json"), JSON.stringify({ status: "failed" }));
      assert.deepEqual(await enforceRetention(boundary), []);
      assert.deepEqual(await readdir(boundary), ["current", "previous"]);
    }));
  }
});

test("concurrent sweeps converge without deleting the retained variant", async t => {
  await withFakeBoundary(t, async boundary => {
    for (let index = 0; index < 6; index++) await createCompletedRun(join(boundary, `run-${index}`), { endedAt: new Date(index * 1000).toISOString() });
    await createCompletedRun(join(boundary, "other"), { variantId: "other" });
    await Promise.all(Array.from({ length: 8 }, () => enforceRetention(boundary)));
    assert.deepEqual(await readdir(boundary), ["other", "run-5"]);
  });
});

test("retention excludes completed runs belonging to a different POSIX uid", async t => {
  if (!process.getuid) return t.skip("POSIX uid ownership is unavailable");
  await withFakeBoundary(t, async boundary => {
    const completed = join(boundary, "foreign-owner-run");
    await createCompletedRun(completed);
    const uid = (await lstat(completed)).uid;
    t.mock.method(process, "getuid", () => uid + 1);
    assert.deepEqual(await enforceRetention(boundary, removeAllCompleted), []);
    assert.equal((await lstat(completed)).uid, uid);
  });
});

test("running, cleaning, and malformed manifests protect their entire run", async t => {
  for (const [name, manifest] of [
    ["running", JSON.stringify({ source: "outer.mjs", status: "running" })],
    ["cleaning", JSON.stringify({ source: "outer.mjs", status: "cleaning" })],
    ["malformed", "{malformed manifest"],
    ["invalid-time", JSON.stringify({ source: "outer.mjs", status: "passed", endedAt: "unknown" })],
  ]) {
    await t.test(name, async subtest => withFakeBoundary(subtest, async boundary => {
      const outer = join(boundary, name), nested = join(outer, "nested", "completed");
      await createCompletedRun(nested);
      await writeFile(join(outer, "manifest.json"), manifest);
      assert.deepEqual(await enforceRetention(boundary, removeAllCompleted), []);
      assert.equal((await stat(nested)).isDirectory(), true);
    }));
  }
});

test("failed cleanup and unconfirmed external scratch are retained", async t => {
  await withFakeBoundary(t, async boundary => {
    for (const [name, extra] of [
      ["failed-cleanup", { cleanupSteps: [{ status: "failed", label: "original owner cleanup" }] }],
      ["retained-scratch", { scratchDirectories: [{ requireCleanupConfirmation: true, cleanupConfirmed: false }] }],
    ]) await createCompletedRun(join(boundary, name), extra);
    assert.deepEqual(await enforceRetention(boundary, removeAllCompleted), []);
    assert.equal((await readdir(boundary)).length, 2);
  });
});

test("retention never follows a directory link outside its boundary", async t => {
  await withFakeBoundary(t, async (boundary, root) => {
    const outside = join(root, "outside-run"), link = join(boundary, "linked-run");
    await createCompletedRun(outside);
    try { await symlink(outside, link, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) return t.skip(`directory links unavailable: ${error.code}`);
      throw error;
    }
    assert.deepEqual(await enforceRetention(boundary, removeAllCompleted), []);
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal((await stat(outside)).isDirectory(), true);
  });
});

async function withFakeBoundary(t, body) {
  const root = await mkdtemp(join(tmpdir(), "kcoder-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boundary = join(root, "fakeboundary");
  await mkdir(boundary);
  return body(boundary, root);
}

async function createCompletedRun(path, extra = {}) {
  await mkdir(join(path, "artifacts"), { recursive: true });
  await writeFile(join(path, "artifacts/result.json"), JSON.stringify({ status: extra.status ?? "passed" }));
  await writeFile(join(path, "manifest.json"), JSON.stringify({ source: "fixture.mjs", status: "passed", endedAt: new Date(0).toISOString(), ...extra }));
}
