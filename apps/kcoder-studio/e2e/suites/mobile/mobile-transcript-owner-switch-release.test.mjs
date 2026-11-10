import test from "node:test";
import assert from "node:assert/strict";
import { buildHeldRouteForwardWitness } from "./mobile-transcript-owner-switch-release.mjs";

function fixture() {
  const request = {
    id: "7",
    method: "thread/read/indexed",
    threadId: "thread-A",
    beforeCursor: "tp1:ob1-abc:4",
    requestOrdinal: 19,
    socketOrdinal: 5,
    rawRequest: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "thread/read/indexed",
      params: { threadId: "thread-A", beforeCursor: "tp1:ob1-abc:4" },
    }),
  };
  const rawResponse = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { history: [] } });
  const held = {
    response: { request, responseOrdinal: 20 },
    rawResponse,
    socketOrdinal: 5,
    heldAtMs: 20,
  };
  const routeForward = {
    request,
    socketOrdinal: 5,
    rawResponse,
    responseOrdinal: 20,
    heldAtMs: 20,
    releasedAtMs: 30,
    forwardedAtMs: 31,
    responseOrdinal: 20,
  };
  return {
    held,
    routeForward,
    browserSocketOrdinal: 5,
    browserRequestFrame: { raw: request.rawRequest, frameOrdinal: 8, atMs: 18, browserSocketOrdinal: 5 },
    browserInitializeFrame: { frame: { method: "initialize" }, frameOrdinal: 1, browserSocketOrdinal: 5 },
    nativeUpstreamFrame: { raw: rawResponse, frameOrdinal: 14, atMs: 19, browserSocketOrdinal: 5 },
    ownerBMarker: "TRANSCRIPT_OWNER_B_00",
    ownerBMarkersBeforeRelease: ["TRANSCRIPT_OWNER_B_00"],
    ownerBMarkersAfterRelease: ["TRANSCRIPT_OWNER_B_00"],
    aOnlyMarkers: ["TRANSCRIPT_SENTINEL_00"],
  };
}

test("held response witness binds exact route-forwarded frame and post-release owner B state", () => {
  const witness = buildHeldRouteForwardWitness(fixture());
  assert.equal(witness.request.requestOrdinal, 19);
  assert.equal(witness.browserRequest.frameOrdinal, 8);
  assert.equal(witness.nativeUpstreamTransportObservation.frameOrdinal, 14);
  assert.ok(witness.nativeUpstreamTransportObservation.atMs < witness.routeForward.heldAtMs,
    "the upstream native observation may precede route hold without proving a client receive");
  assert.equal(witness.routeForward.heldBeforeReleaseBeforeForward, true);
  assert.match(witness.evidenceBoundary, /no native Browser receive or app-dispatch/);
  assert.equal(witness.noAContentPublishedIntoB, true);
});

test("held response witness rejects route forwarding before release", () => {
  const input = fixture();
  input.routeForward.forwardedAtMs = 29;
  assert.throws(() => buildHeldRouteForwardWitness(input), /at or after release/);
});

test("held response witness rejects a different raw frame or socket identity", () => {
  const wrongRaw = fixture();
  wrongRaw.routeForward.rawResponse = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { history: ["other"] } });
  assert.throws(() => buildHeldRouteForwardWitness(wrongRaw), /unmodified held server frame/);

  const wrongSocket = fixture();
  wrongSocket.routeForward.socketOrdinal = 4;
  assert.throws(() => buildHeldRouteForwardWitness(wrongSocket), /exact held RPC socket/);
});
