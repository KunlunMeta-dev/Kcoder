import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_RETENTION, enforceRetention, planRetention } from "./retention.mjs";

test("retention keeps only five recent successes and twenty recent failures per source", () => {
  const now = Date.now();
  const runs = [
    ...Array.from({ length: 7 }, (_, index) => run(`/success-${index}`, "a.e2e.mjs", "passed", now - index * 1_000, 1)),
    ...Array.from({ length: 22 }, (_, index) => run(`/failure-${index}`, "a.e2e.mjs", "failed", now - index * 1_000, 1)),
  ];
  const removed = new Set(planRetention(runs, now).map(item => item.path));
  assert.equal(removed.has("/success-5"), true);
  assert.equal(removed.has("/success-6"), true);
  assert.equal(removed.has("/failure-20"), true);
  assert.equal(removed.has("/failure-21"), true);
  assert.equal(removed.size, 4);
});

test("retention expires runs by status-specific age", () => {
  const now = Date.now();
  const success = run("/old-success", "a.e2e.mjs", "passed", now - DEFAULT_RETENTION.successfulMaxAgeMs - 1, 1);
  const failure = run("/old-failure", "a.e2e.mjs", "failed", now - DEFAULT_RETENTION.failedMaxAgeMs - 1, 1);
  assert.deepEqual(planRetention([success, failure], now).map(item => item.path).sort(), ["/old-failure", "/old-success"]);
});

test("retention preserves private sibling directories and still discovers readable runs", async t => {
  if (!process.getuid || process.getuid() === 0) {
    return t.skip("Requires a non-root POSIX test owner");
  }
  await withFakeBoundary(t, async boundary => {
    const hidden = join(boundary, "private-sibling");
    const stale = join(boundary, "readable-run");
    await mkdir(hidden, { mode: 0o700 });
    await mkdir(stale);
    await writeFile(join(stale, "manifest.json"), JSON.stringify({
      status: "passed",
      source: "readable.e2e.mjs",
      endedAt: new Date(0).toISOString(),
    }));
    await chmod(hidden, 0o000);
    try {
      assert.deepEqual(await enforceRetention(boundary), [stale]);
      assert.ok((await lstat(hidden)).isDirectory());
      assert.equal((await lstat(hidden)).mode & 0o777, 0);
    } finally {
      await chmod(hidden, 0o700);
    }
  });
});

test("retention excludes readable completed runs belonging to a different POSIX uid", async t => {
  if (!process.getuid) return t.skip("POSIX uid ownership is unavailable");
  await withFakeBoundary(t, async boundary => {
    const completed = join(boundary, "foreign-owner-run");
    await createExpiredCompletedRun(completed);
    const originalUid = (await lstat(completed)).uid;
    // Only the caller uid is synthetic; the readable directory keeps its real owner.
    t.mock.method(process, "getuid", () => originalUid + 1);
    assert.deepEqual(await enforceRetention(boundary), []);
    assert.equal(JSON.parse(await readFile(join(completed, "manifest.json"), "utf8")).status, "passed");
    assert.equal((await lstat(completed)).uid, originalUid);
  });
});

test("retention preserves a completed run when deletion permission is denied", async t => {
  if (!process.getuid || process.getuid() === 0) {
    return t.skip("Requires a non-root POSIX test owner");
  }
  await withFakeBoundary(t, async boundary => {
    const protectedRun = join(boundary, "protected-completed-run");
    const removableRun = join(boundary, "removable-completed-run");
    await createExpiredCompletedRun(protectedRun);
    await createExpiredCompletedRun(removableRun);
    await chmod(protectedRun, 0o555);
    try {
      assert.deepEqual(await enforceRetention(boundary), [removableRun]);
      assert.equal(JSON.parse(await readFile(join(protectedRun, "manifest.json"), "utf8")).status, "passed");
      assert.equal((await lstat(protectedRun)).mode & 0o777, 0o555);
    } finally {
      await chmod(protectedRun, 0o700);
    }
  });
});

test("retention enforces the two GiB global cap and evicts passed evidence first", () => {
  const now = Date.now();
  const gib = 1024 * 1024 * 1024;
  const runs = [
    run("/passed", "a.e2e.mjs", "passed", now - 1_000, gib),
    run("/failed", "b.e2e.mjs", "failed", now - 2_000, gib),
    run("/new-failed", "c.e2e.mjs", "failed", now, gib),
  ];
  const removed = planRetention(runs, now).map(item => item.path);
  assert.deepEqual(removed, ["/passed"]);
});

test("retention counts every varied file before applying the global quota", async t => {
  await withFakeBoundary(t, async boundary => {
    const quota = DEFAULT_RETENTION.totalMaxBytes;
    const passedPayloadBytes = 8 * 1024 * 1024;
    const failedPayloadBytes = quota - passedPayloadBytes - 1;
    const passed = join(boundary, "recent-passed-run");
    const failed = join(boundary, "recent-failed-run");
    const passedSize = await createRecentCompletedRunWithFiles(
      passed,
      "quota-pass.e2e.mjs",
      "passed",
      passedPayloadBytes,
      64,
    );
    const failedSize = await createRecentCompletedRunWithFiles(
      failed,
      "quota-fail.e2e.mjs",
      "failed",
      failedPayloadBytes,
      64,
    );

    assert.ok(passedSize + failedSize > quota, "the exact directory sizes must cross the global quota");
    assert.ok(failedSize < quota, "the failed evidence remains within quota after the passed run is removed");
    assert.deepEqual(await enforceRetention(boundary), [passed]);
    await assert.rejects(stat(passed), error => error.code === "ENOENT");
    assert.equal((await stat(failed)).isDirectory(), true);
  });
});

test("running, cleaning, and malformed manifests keep nested completed runs", async t => {
  const cases = [
    ["running", JSON.stringify({ source: "outer.e2e.mjs", status: "running", endedAt: null })],
    ["cleaning", JSON.stringify({ source: "outer.e2e.mjs", status: "cleaning", endedAt: null })],
    ["malformed", "{malformed manifest"],
  ];

  for (const [name, manifest] of cases) {
    await t.test(name, async subtest => withFakeBoundary(subtest, async boundary => {
      const outer = join(boundary, name);
      const nested = join(outer, "nested", "completed-run");
      await mkdir(join(outer, "nested"), { recursive: true });
      await writeFile(join(outer, "manifest.json"), manifest);
      await writeFile(join(outer, "sentinel.txt"), `keep outer ${name}`);
      await createExpiredCompletedRun(nested);
      await writeFile(join(nested, "sentinel.txt"), `keep nested ${name}`);

      assert.deepEqual(await enforceRetention(boundary), []);
      assert.equal(await readFile(join(outer, "sentinel.txt"), "utf8"), `keep outer ${name}`);
      assert.equal(await readFile(join(nested, "sentinel.txt"), "utf8"), `keep nested ${name}`);
    }));
  }
});

test("cleanup failures and unconfirmed external scratch remain outside retention deletion", async t => {
  await withFakeBoundary(t, async boundary => {
    for (const [name, extra] of [
      ["failed-cleanup", { cleanupSteps: [{ status: "failed", label: "original owner cleanup" }] }],
      ["retained-scratch", { scratchDirectories: [{ requireCleanupConfirmation: true, cleanupConfirmed: false }] }],
    ]) {
      const path = join(boundary, name);
      await createExpiredCompletedRun(path);
      const manifestPath = join(path, "manifest.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      await writeFile(manifestPath, JSON.stringify({ ...manifest, ...extra }));
    }
    assert.deepEqual(await enforceRetention(boundary), []);
    assert.equal((await stat(join(boundary, "failed-cleanup"))).isDirectory(), true);
    assert.equal((await stat(join(boundary, "retained-scratch"))).isDirectory(), true);
  });
});

test("retention still removes an expired completed run", async t => {
  await withFakeBoundary(t, async boundary => {
    const completed = join(boundary, "expired-completed-run");
    await createExpiredCompletedRun(completed);

    assert.deepEqual(await enforceRetention(boundary), [completed]);
    await assert.rejects(stat(completed), error => error.code === "ENOENT");
  });
});

test("retention does not follow a symlink outside its boundary", async t => {
  await withFakeBoundary(t, async (boundary, privateRoot) => {
    const outside = join(privateRoot, "outside-run");
    const link = join(boundary, "linked-run");
    await createExpiredCompletedRun(outside);
    await writeFile(join(outside, "sentinel.txt"), "outside sentinel");
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) {
        t.skip(`directory symlinks are unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.deepEqual(await enforceRetention(boundary), []);
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "outside sentinel");
  });
});

async function withFakeBoundary(t, run) {
  const privateRoot = await mkdtemp(join(tmpdir(), "kcoder-retention-"));
  t.after(() => rm(privateRoot, { recursive: true, force: true }));
  const boundary = join(privateRoot, "fakeboundary");
  await mkdir(boundary);
  return run(boundary, privateRoot);
}

async function createExpiredCompletedRun(path) {
  await mkdir(path, { recursive: true });
  const endedAt = new Date(Date.now() - DEFAULT_RETENTION.successfulMaxAgeMs - 1).toISOString();
  await writeFile(join(path, "manifest.json"), JSON.stringify({
    source: "fixture.e2e.mjs",
    status: "passed",
    endedAt,
  }));
}

async function createRecentCompletedRunWithFiles(path, source, status, payloadBytes, fileCount) {
  await mkdir(path, { recursive: true });
  const payloadDirectory = join(path, "artifacts", "mobile-web-export", "assets", "node_modules");
  await mkdir(payloadDirectory, { recursive: true });
  const manifestPath = join(path, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    source,
    status,
    endedAt: new Date(Date.now() - 1_000).toISOString(),
  }));

  const sizes = variedFileSizes(payloadBytes, fileCount);
  for (const [index, size] of sizes.entries()) {
    const file = join(payloadDirectory, `payload-${String(index).padStart(3, "0")}.bin`);
    await writeFile(file, "");
    await truncate(file, size);
  }
  return sizes.reduce((total, size) => total + size, (await stat(manifestPath)).size);
}

function variedFileSizes(totalBytes, count) {
  const weights = Array.from({ length: count }, (_, index) => 64 + ((index * 17) % 53));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const sizes = weights.map(weight => Math.floor(totalBytes * weight / totalWeight));
  let remainder = totalBytes - sizes.reduce((sum, size) => sum + size, 0);
  for (let index = 0; remainder > 0; index += 1, remainder -= 1) sizes[index % sizes.length] += 1;
  return sizes;
}

function run(path, source, status, endedAtMs, sizeBytes) {
  return { path, source, status, endedAtMs, sizeBytes };
}
