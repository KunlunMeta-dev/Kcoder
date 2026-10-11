import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  classifyObservedRpcRequest,
  hasCompleteRpcAttribution,
  matchesObservedRpcPair,
  parseObservedJsonRpcFrame,
} from "./mobile-public-new-catalog-dom-probe.candidate.mjs";

test("parses text and binary JSON-RPC 2.0 responses with result or legal error", () => {
  const result = parseObservedJsonRpcFrame("server-to-client",
    '{"jsonrpc":"2.0","id":"r1","result":null}');
  assert.equal(result.ok, true);
  assert.equal(result.envelopeKind, "response");
  assert.equal(result.responseShape, "result");

  const error = parseObservedJsonRpcFrame("server-to-client", Buffer.from(
    '{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"unavailable"}}'));
  assert.equal(error.ok, true);
  assert.equal(error.envelopeKind, "response");
  assert.equal(error.responseShape, "error");

  const request = parseObservedJsonRpcFrame("client-to-server",
    '{"jsonrpc":"2.0","id":2,"method":"runtime.models.list","params":{}}');
  assert.equal(request.ok, true);
  assert.equal(request.envelopeKind, "request");
  const notification = parseObservedJsonRpcFrame("client-to-server",
    '{"jsonrpc":"2.0","method":"initialized"}');
  assert.equal(notification.ok, true);
  assert.equal(notification.envelopeKind, "notification");
});

test("rejects wrong-direction and invalid response envelopes", () => {
  const invalid = [
    ["client-to-server", '{"jsonrpc":"2.0","id":1,"result":null}'],
    ["server-to-client", '{"jsonrpc":"2.0","id":1}'],
    ["server-to-client", '{"jsonrpc":"2.0","id":1,"result":null,"error":{"code":-1,"message":"x"}}'],
    ["server-to-client", '{"jsonrpc":"2.0","id":1,"error":{"code":"bad","message":"x"}}'],
    ["server-to-client", '{"jsonrpc":"2.0","id":1,"error":{"code":-1.5,"message":"x"}}'],
    ["server-to-client", '{"id":1,"result":null}'],
    ["server-to-client", '{not-json'],
  ];
  for (const [direction, payload] of invalid) {
    const parsed = parseObservedJsonRpcFrame(direction, payload);
    assert.equal(parsed.ok, false, payload);
    assert.equal(Object.hasOwn(parsed, "frame"), false, "failure diagnostics do not retain payload data");
  }
  assert.equal(parseObservedJsonRpcFrame("server-to-client", new Uint8Array([0xff])).reason, "invalid-utf8");
  assert.equal(parseObservedJsonRpcFrame("server-to-client", 12).reason, "unsupported-payload");
  assert.equal(parseObservedJsonRpcFrame("server-to-client", "x".repeat(2 * 1024 * 1024 + 1)).reason,
    "frame-too-large");
});

test("classifies initialize as a phase-preserving non-target handshake, never catalog evidence", () => {
  for (const phase of ["setup", "action", "boundary-unknown"]) {
    assert.deepEqual(classifyObservedRpcRequest({ direction: "client-to-server", routeOwned: true,
      phase, method: "initialize" }), { phase, target: false, classification: "initialize-handshake" });
  }
  assert.deepEqual(classifyObservedRpcRequest({ direction: "client-to-server", routeOwned: true,
    phase: "action", method: "runtime.models.list" }),
  { phase: "action", target: true, classification: "read-only-catalog-request" });
  assert.equal(classifyObservedRpcRequest({ direction: "client-to-server", routeOwned: true,
    phase: "action", method: "turn/start" }).classification, "mutating-request");
  assert.equal(classifyObservedRpcRequest({ direction: "client-to-server", routeOwned: true,
    phase: "action", method: "unrecognized/method" }).classification, "unexpected-request");
});

test("correlates only actual server responses on the same owned socket and request", () => {
  const request = { kind: "rpc-request", routeOwned: true, direction: "client-to-server",
    routeSocketId: "page-1-socket-2", idFingerprint: "id-hash", requestSequence: 4,
    phase: "action", target: true, classification: "read-only-catalog-request", method: "runtime.models.list" };
  const response = { kind: "rpc-response", routeOwned: true, direction: "server-to-client",
    envelopeKind: "response", responseShape: "result", error: false,
    requestDirection: "client-to-server", routeSocketId: "page-1-socket-2", idFingerprint: "id-hash",
    requestSequence: 4, phase: "action", target: true,
    classification: "read-only-catalog-request", method: "runtime.models.list" };
  assert.equal(matchesObservedRpcPair(request, response), true);
  assert.equal(matchesObservedRpcPair(request, { ...response, direction: "client-to-server" }), false,
    "the copied requestDirection cannot substitute for the actual response direction");
  assert.equal(matchesObservedRpcPair(request, { ...response, responseShape: "invalid", error: false }), false);
  assert.equal(matchesObservedRpcPair(request, { ...response, routeSocketId: "other-socket" }), false);
  assert.equal(matchesObservedRpcPair(request, { ...response, idFingerprint: "other-id" }), false);
});

test("requires a matched non-initialize action RPC and preserves fail-closed gates", () => {
  const complete = { actionClickReceived: true, observedActionRpcClosed: true,
    actionNonInitializeCatalogRequestCount: 1, actionNonInitializeCatalogMatchedResponseCount: 1,
    boundaryUnknownNonHandshakeRpcRequestCount: 0, unansweredActionTargetRequestCount: 0,
    actionTargetResponseErrors: 0, unexpectedRpcTraffic: false,
    boundaryUnknownInitializeHandshakeCount: 1 };
  assert.equal(hasCompleteRpcAttribution(complete), true,
    "a counted boundary initialize handshake alone is not action evidence or a blocking ambiguity");
  assert.equal(hasCompleteRpcAttribution({ ...complete, actionNonInitializeCatalogRequestCount: 0,
    actionNonInitializeCatalogMatchedResponseCount: 0 }), false);
  assert.equal(hasCompleteRpcAttribution({ ...complete, boundaryUnknownNonHandshakeRpcRequestCount: 1 }), false);
  assert.equal(hasCompleteRpcAttribution({ ...complete, actionTargetResponseErrors: 1 }), false);
  assert.equal(hasCompleteRpcAttribution({ ...complete, unexpectedRpcTraffic: true }), false,
    "mutations, unknown requests and unexpected notifications remain blocking inputs");
});
