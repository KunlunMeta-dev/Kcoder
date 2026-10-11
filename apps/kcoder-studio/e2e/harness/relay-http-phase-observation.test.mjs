import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyRelayPublicHttpDiagnosticOverlay,
  createRelayHttpDiagnosticCollector,
  RELAY_HTTP_DIAGNOSTIC_BASE_SHA256,
  RELAY_HTTP_DIAGNOSTIC_OVERLAY_SHA256,
  sha256,
  summarizeFetchFailure,
} from "./relay-http-phase-observation.mjs";

const frozenRelayServerPath = new URL(
  "../../../kcoder-relay/src/server.mjs",
  import.meta.url,
);

test("fixed Relay server overlay is deterministic and applies only to the pinned source", async () => {
  const source = await readFile(frozenRelayServerPath, "utf8");
  const overlay = applyRelayPublicHttpDiagnosticOverlay(source);

  assert.equal(sha256(source), RELAY_HTTP_DIAGNOSTIC_BASE_SHA256);
  assert.equal(overlay.baseSha256, RELAY_HTTP_DIAGNOSTIC_BASE_SHA256);
  assert.equal(overlay.sourceSha256, RELAY_HTTP_DIAGNOSTIC_OVERLAY_SHA256);
  assert.match(overlay.source, /diagnostic\('public-http-entry'/);
  assert.match(overlay.source, /event: 'control-open-dispatch'/);
  assert.match(overlay.source, /event: 'pending-data-attach-start'/);
  assert.match(overlay.source, /diagnostic\('relay-upstream-error'/);
  assert.throws(
    () => applyRelayPublicHttpDiagnosticOverlay(source.replace("const SESSION_PATH", "const SESSION_PATH_CHANGED")),
    /source SHA-256 mismatch/,
  );
});

test("Relay event collector rejects unknown fields and retains bounded safe records", () => {
  const secret = "private-fixture-pairing-value";
  const collector = createRelayHttpDiagnosticCollector({ maxEvents: 1, maxBytes: 4096 });
  const safeRecord = {
    event: "public-http-entry",
    requestId: "a".repeat(16),
    atUnixMs: 1234,
    elapsedMs: 2.4,
    method: "POST",
  };

  assert.equal(collector.push({ ...safeRecord, pairingToken: secret }), false);
  for (const forbidden of [
    { url: "/g/private-id/api/mobile/session?token=" + secret },
    { headers: { authorization: "Bearer " + secret } },
    { gatewayId: "private-gateway-id" },
    { peerIp: "203.0.113.9" },
    { body: secret },
  ]) {
    assert.equal(collector.push({ ...safeRecord, ...forbidden }), false);
  }
  assert.equal(collector.push(safeRecord), true);
  assert.equal(collector.push({ event: "public-response-finished", requestId: "b".repeat(16), statusCode: 200 }), false);
  const snapshot = collector.snapshot();

  assert.equal(snapshot.eventCount, 1);
  assert.equal(snapshot.droppedCount, 1);
  assert.equal(snapshot.rejectedCount, 6);
  assert.equal(snapshot.events[0].method, "POST");
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
});

test("fetch failure summary keeps only allowlisted name and direct cause codes", () => {
  const secret = "do-not-retain-secret";
  const cause = Object.assign(new Error(secret), { code: "ECONNRESET" });
  const failure = new TypeError("request to https://example.invalid/?token=" + secret + " failed", { cause });
  failure.code = "NOT_ALLOWLISTED";
  const summary = summarizeFetchFailure(failure);

  assert.deepEqual(summary, {
    name: "TypeError",
    code: "OTHER",
    causeName: "Error",
    causeCode: "ECONNRESET",
  });
  assert.equal(JSON.stringify(summary).includes(secret), false);

  const unknownCause = Object.assign(new Error(secret), { code: "UNSAFE-" + secret });
  assert.deepEqual(summarizeFetchFailure(Object.assign(new Error(secret), { cause: unknownCause })), {
    name: "Error",
    code: "OTHER",
    causeName: "Error",
    causeCode: "OTHER",
  });
});
