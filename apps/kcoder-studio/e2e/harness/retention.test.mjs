import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RETENTION, planRetention } from "./retention.mjs";

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

function run(path, source, status, endedAtMs, sizeBytes) {
  return { path, source, status, endedAtMs, sizeBytes };
}

