import assert from "node:assert/strict";
import test from "node:test";
import {
  createAcceptedTurnReceiptFixture,
  createResponseJitter,
  mobileApiPath,
  sanitizeGatewayPath,
  sumResponseDelayMs,
} from "./mobile-high-latency-fault-fixture.mjs";

test("response-delay composition defaults omitted terms to zero and rejects invalid configured values", () => {
  assert.equal(sumResponseDelayMs(undefined), 0);
  assert.equal(sumResponseDelayMs(0, undefined, 12_000), 12_000);
  assert.equal(sumResponseDelayMs(300, 600, 100), 1_000);
  assert.throws(() => sumResponseDelayMs(Number.NaN, 12_000), /finite non-negative/);
  assert.throws(() => sumResponseDelayMs(0, -1), /finite non-negative/);
  assert.throws(() => sumResponseDelayMs(Number.POSITIVE_INFINITY), /finite non-negative/);
});

test("jitter uses a stable per-layer, per-operation sequence and cycles explicitly", () => {
  const jitter = createResponseJitter({
    http: { "/api/servers/status": [0, 100, 900, 300] },
    rpc: { "thread/read": [50, 250] },
  });
  assert.deepEqual([0, 1, 2, 3, 4].map(() => jitter.next("http", "/api/servers/status")), [
    { sampleIndex: 0, delayMs: 0 },
    { sampleIndex: 1, delayMs: 100 },
    { sampleIndex: 2, delayMs: 900 },
    { sampleIndex: 3, delayMs: 300 },
    { sampleIndex: 4, delayMs: 0 },
  ]);
  assert.deepEqual(jitter.next("rpc", "thread/read"), { sampleIndex: 0, delayMs: 50 });
  assert.deepEqual(jitter.counts(), { "http:/api/servers/status": 5, "rpc:thread/read": 1 });
});

test("receipt fixture accepts only a real observed response and exact identity readback", () => {
  const fixture = createAcceptedTurnReceiptFixture();
  const scope = {};
  const identity = fixture.observeTurnStartRequest({ threadId: "thread-a", clientMessageId: "composer-a" }, scope, 7);
  assert.deepEqual({
    threadId: identity.threadId,
    clientMessageId: identity.clientMessageId,
    routeSocketId: identity.routeSocketId,
    requestCount: identity.requestCount,
  }, { threadId: "thread-a", clientMessageId: "composer-a", routeSocketId: 7, requestCount: 1 });
  assert.equal(fixture.read(identity, scope, 8), null, "a planned request cannot be reported accepted without a server response");
  assert.equal(fixture.observeTurnStartResponse(identity, { error: { code: -1 } }, 7), false);
  assert.equal(fixture.observeTurnStartResponse(identity, { result: { turn: { id: "wrong-socket" } } }, 8), false, "a response from another transport socket cannot establish acceptance");
  assert.equal(fixture.observeTurnStartResponse(identity, { result: { turn: { id: "turn-a", status: "running" } } }, 7), true);
  assert.deepEqual(fixture.read(identity, scope, 8), { threadId: "thread-a", turnId: "turn-a", status: "running" });
  assert.equal(fixture.read({ threadId: "thread-a", clientMessageId: "composer-a" }, {}, 9), null, "another isolated browser connection cannot read this fixture receipt");
  assert.equal(fixture.read({ threadId: "thread-a", clientMessageId: "composer-b" }, scope, 8), null);
  assert.equal(fixture.read({ threadId: "thread-b", clientMessageId: "composer-a" }, scope, 8), null);
  assert.equal(fixture.hasExactReceipt(identity, scope), true);
  const summary = JSON.stringify(fixture.summary());
  assert.doesNotMatch(summary, /composer-a|thread-a|turn-a/);
  assert.deepEqual(fixture.summary(), {
    fixtureKind: "in-memory isolated mock only; not a durable Rust app-server receipt",
    turnStartRequestCount: 1,
    acceptedResponseCount: 1,
    receiptReadCount: 5,
    receiptMismatchCount: 4,
    duplicatePairRequestCount: 0,
    invalidScopeCount: 0,
    acceptedIdentityFingerprints: [{
      scopeFingerprint: "3023d98f899ec56a",
      threadIdFingerprint: "8b983fb92d2eb127",
      clientMessageIdFingerprint: "86fb34dbe15a9015",
      turnIdFingerprint: "2dfa6d12e5e99b53",
      requestCountForPair: 1,
      responseObservedOnRouteSocketId: 7,
      responseMatchedRequestSocket: true,
      receiptReadOnDifferentRouteSocket: true,
      status: "running",
    }],
  });
});

test("receipt fixture refuses same-identity duplicate turn/start and never overwrites its first accepted receipt", () => {
  const fixture = createAcceptedTurnReceiptFixture();
  const scope = {};
  const params = { threadId: "thread-a", clientMessageId: "composer-a" };
  const first = fixture.observeTurnStartRequest(params, scope, 7);
  assert.equal(fixture.observeTurnStartResponse(first, { result: { turn: { id: "turn-a", status: "running" } } }, 7), true);
  const duplicate = fixture.observeTurnStartRequest(params, scope, 8);
  assert.equal(duplicate.requestCount, 2);
  assert.equal(fixture.observeTurnStartResponse(duplicate, { result: { turn: { id: "turn-b", status: "running" } } }, 8), false);
  assert.deepEqual(fixture.read(params, scope, 9), { threadId: "thread-a", turnId: "turn-a", status: "running" });
  assert.deepEqual(fixture.summary(), {
    fixtureKind: "in-memory isolated mock only; not a durable Rust app-server receipt",
    turnStartRequestCount: 2,
    acceptedResponseCount: 1,
    receiptReadCount: 1,
    receiptMismatchCount: 0,
    duplicatePairRequestCount: 1,
    invalidScopeCount: 0,
    acceptedIdentityFingerprints: [{
      scopeFingerprint: "3023d98f899ec56a",
      threadIdFingerprint: "8b983fb92d2eb127",
      clientMessageIdFingerprint: "86fb34dbe15a9015",
      turnIdFingerprint: "2dfa6d12e5e99b53",
      requestCountForPair: 1,
      responseObservedOnRouteSocketId: 7,
      responseMatchedRequestSocket: true,
      receiptReadOnDifferentRouteSocket: true,
      status: "running",
    }],
  });
});

test("public route path is redacted while the API suffix remains classifiable", () => {
  assert.equal(sanitizeGatewayPath("/g/0123456789abcdef0123456789abcdef/api/servers/status"), "/g/<private-route>/api/servers/status");
  assert.equal(mobileApiPath("/g/0123456789abcdef0123456789abcdef/api/servers/status"), "/api/servers/status");
  assert.equal(mobileApiPath("/api/servers"), "/api/servers");
});
