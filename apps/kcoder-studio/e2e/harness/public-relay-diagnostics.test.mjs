import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import {
  createBoundedRelayDiagnosticCollector,
  readBoundedErrorResponseBody,
} from "./public-relay-diagnostics.mjs";

test("non-success response capture bounds a 4097-byte body and marks truncation", async () => {
  const response = new Response("x".repeat(4097), { status: 504 });
  const result = await readBoundedErrorResponseBody(response, text => text);

  assert.equal(result.status, "captured");
  assert.equal(result.text.length, 4096);
  assert.equal(result.truncated, true);
  assert.equal(response.bodyUsed, true, "the original error response body is consumed");
});

test("slow non-success body reports its deadline without awaiting a stuck cancel", async () => {
  const body = new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { return new Promise(() => {}); },
  });
  const response = { status: 504, body };
  const started = performance.now();
  const result = await readBoundedErrorResponseBody(response, text => text, { deadlineMs: 30 });
  const elapsedMs = performance.now() - started;

  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.reason, "read-deadline-exceeded");
  assert.deepEqual(result.capturePolicy, {
    maxBytes: 4096,
    deadlineMs: 30,
    wait: "bounded",
    cancellation: "best-effort nonblocking when needed",
    underlyingResourceRelease: "unverified",
  });
  assert.ok(elapsedMs < 500, `deadline result should return promptly, elapsed ${elapsedMs}ms`);
});

test("successful response body is never consumed because it may contain session credentials", async () => {
  let bodyAccessed = false;
  const response = {
    status: 200,
    get body() {
      bodyAccessed = true;
      throw new Error("successful credentials body must not be touched");
    },
  };

  const result = await readBoundedErrorResponseBody(response, text => text);

  assert.deepEqual(result, {
    status: "omitted-sensitive-success-body",
    reason: "session responses can contain newly issued credentials",
    capturePolicy: { body: "not-consumed" },
  });
  assert.equal(bodyAccessed, false);
});

test("client event collector retains only bounded redacted protocol fields", () => {
  const secret = "sensitive-fixture-token-that-must-not-be-retained";
  const collector = createBoundedRelayDiagnosticCollector({
    redactText: text => text.replaceAll(secret, "[REDACTED]"),
    maxEvents: 1,
    maxBytes: 4096,
  });
  const valid = {
    event: "data_error",
    generation: 1,
    atUnixMs: 100,
    monotonicMs: 12.345,
    correlation: "a".repeat(64),
    errorKind: "handshake_status",
    handshakeStatus: 504,
    secret,
  };

  assert.equal(collector.push(valid), false, "unknown fields are rejected before persistence");
  assert.equal(collector.snapshot().rejectedCount, 1);
  assert.equal(collector.push({ ...valid, secret: undefined }), false, "undefined unknown fields are also rejected");
  assert.equal(collector.push({
    event: "data_error",
    generation: 1,
    atUnixMs: 100,
    monotonicMs: 12.345,
    correlation: "a".repeat(64),
    errorKind: "handshake_status",
    handshakeStatus: 504,
  }), true);
  assert.equal(collector.push({
    event: "control_open",
    generation: 1,
    atUnixMs: 101,
    monotonicMs: 13,
  }), false, "the event limit is enforced");

  const snapshot = collector.snapshot();
  assert.equal(snapshot.eventCount, 1);
  assert.equal(snapshot.droppedCount, 1);
  assert.equal(snapshot.events[0].handshakeStatus, 504);
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
});
