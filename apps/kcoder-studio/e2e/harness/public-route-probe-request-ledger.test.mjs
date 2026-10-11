import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createPublicRouteProbeRequestLedger } from "./public-route-probe-request-ledger.mjs";
import { runE2E } from "./run-context.mjs";

test("public route-probe request ledger writes immutable entries through failure cleanup", async () => {
  let runRoot;
  let firstEntryBytes;
  await assert.rejects(runE2E(import.meta.url, {
    testId: "public-route-probe-request-ledger-failure-cleanup",
    tier: "harness-unit",
    modelPolicy: "model-independent RunContext artifact immutability and LIFO cleanup",
    retainSuccessLogs: true,
  }, async context => {
    runRoot = context.runRoot;
    const ledger = createPublicRouteProbeRequestLedger(context);
    const firstEntryName = "route-probe-public-api-request-001.json";
    await ledger.record({
      gateway: "alpha",
      routeFingerprint: "a".repeat(64),
      method: "POST /api/mobile/session",
      path: "/g/<private-id>/api/mobile/session",
      requestStartedAt: "2026-10-08T00:00:00.000Z",
      elapsedMs: 1,
      status: 200,
    });
    firstEntryBytes = await readFile(resolve(context.artifactsDir, firstEntryName));

    await ledger.record({
      gateway: "alpha",
      routeFingerprint: "a".repeat(64),
      method: "GET /api/servers",
      path: "/g/<private-id>/api/servers",
      requestStartedAt: "2026-10-08T00:00:00.001Z",
      elapsedMs: 2,
      status: 200,
    });
    assert.deepEqual(await readFile(resolve(context.artifactsDir, firstEntryName)), firstEntryBytes);

    context.addCleanup("record failure cleanup DELETE", async () => {
      await ledger.record({
        gateway: "alpha",
        routeFingerprint: "a".repeat(64),
        method: "DELETE /api/mobile/session",
        path: "/g/<private-id>/api/mobile/session",
        requestStartedAt: "2026-10-08T00:00:00.002Z",
        elapsedMs: 3,
        status: 204,
      });
    });
    throw new Error("expected route-probe fixture failure");
  }), /expected route-probe fixture failure/);

  const artifacts = resolve(runRoot, "artifacts");
  const names = (await readdir(artifacts)).sort();
  assert.deepEqual(names, [
    "result.json",
    "route-probe-public-api-request-001.json",
    "route-probe-public-api-request-002.json",
    "route-probe-public-api-request-003.json",
    "route-probe-public-api-request-ledger-final.json",
  ]);
  assert.deepEqual(await readFile(resolve(artifacts, "route-probe-public-api-request-001.json")), firstEntryBytes);

  const entries = await Promise.all([1, 2, 3].map(async sequence => JSON.parse(
    await readFile(resolve(artifacts, `route-probe-public-api-request-${String(sequence).padStart(3, "0")}.json`), "utf8"),
  )));
  assert.deepEqual(entries.map(entry => [entry.sequence, entry.method, entry.status]), [
    [1, "POST /api/mobile/session", 200],
    [2, "GET /api/servers", 200],
    [3, "DELETE /api/mobile/session", 204],
  ]);
  assert.ok(entries.every(entry => entry.requestPayloadValuesStored === false && entry.automaticRequestRetry === false));

  const finalLedger = JSON.parse(await readFile(resolve(artifacts, "route-probe-public-api-request-ledger-final.json"), "utf8"));
  assert.equal(finalLedger.requestCount, 3);
  assert.deepEqual(finalLedger.methodCounts, {
    "POST /api/mobile/session": 1,
    "GET /api/servers": 1,
    "DELETE /api/mobile/session": 1,
  });
  assert.deepEqual(finalLedger.requests.map(({ sequence, method }) => [sequence, method]), entries.map(({ sequence, method }) => [sequence, method]));

  const result = JSON.parse(await readFile(resolve(artifacts, "result.json"), "utf8"));
  assert.equal(result.status, "failed", "the body failure must trigger RunContext cleanup");
  assert.deepEqual(result.cleanupErrors, [], "all request artifacts and the final cleanup ledger must complete");
});
