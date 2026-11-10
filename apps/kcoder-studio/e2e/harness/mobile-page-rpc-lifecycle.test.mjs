import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { RunContext } from "./run-context.mjs";
import {
  closePageRpcRoutesAndWait,
  correlateMobilePageRpcRoutes,
  mobilePageRpcRoutesClosed,
  observeAndForwardMobileRpcRouteCloses,
} from "./mobile-page-rpc-lifecycle.mjs";

const relayRequire = createRequire(new URL("../../../kcoder-relay/package.json", import.meta.url));
const { WebSocketServer } = relayRequire("ws");

async function withNativeWebSocket(testId, body) {
  const context = await RunContext.create(import.meta.url, {
    testId,
    tier: "model-independent",
    modelPolicy: "Owned loopback and Node global WebSocket API; no Browser or Provider",
  });
  let failure;
  try {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let socket;
    context.addCleanup("close owned native WebSocket fixture", async () => {
      if (socket?.readyState === globalThis.WebSocket.OPEN) socket.close(1000);
      for (const peer of server.clients) peer.terminate();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    await once(server, "listening");
    context.registerPort("native-websocket-close-fixture", server.address().port);
    const peerConnected = once(server, "connection");
    socket = new globalThis.WebSocket(`ws://127.0.0.1:${server.address().port}`);
    await once(socket, "open", { signal: AbortSignal.timeout(5_000) });
    const [peer] = await peerConnected;
    const peerClosed = once(peer, "close");
    await body(socket, peerClosed);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await context.finish(failure ? "failed" : "passed", undefined, failure);
  }
}

function nativeRouteCloseEndpoint(socket) {
  return {
    onClose(callback) { socket.addEventListener("close", event => callback(event.code, event.reason)); },
    close({ code, reason }) { socket.close(code, reason); },
  };
}

test("owner route release is accepted by the real Node WebSocket close API", async () => {
  await withNativeWebSocket("mobile-owner-native-close", async (socket, peerClosed) => {
    assert.throws(() => socket.close(1001), { name: "InvalidAccessError" });
    assert.equal(socket.readyState, globalThis.WebSocket.OPEN,
      "a wire-legal 1001 is rejected by the DOM API without closing the connection");
    const client = makeRouteCloseEndpoint();
    const state = observeAndForwardMobileRpcRouteCloses(client, nativeRouteCloseEndpoint(socket));
    const closed = once(socket, "close", { signal: AbortSignal.timeout(5_000) });
    state.requestCloseFromOwnerRelease();
    assert.equal(state.closeForwardErrorName, null, "owner release must use a DOM-sendable close code");
    const [event] = await closed;
    assert.equal(event.code, 1000);
    assert.equal((await peerClosed)[0], 1000, "the real peer must receive the normal close frame");
    assert.equal(state.upstreamActuallyClosed, true);
  });
});

for (const code of [1001, 3001]) {
  test(`forwarded ${code} is accepted by the real Node WebSocket close API`, async () => {
    await withNativeWebSocket(`mobile-forwarded-native-close-${code}`, async (socket, peerClosed) => {
      const client = makeRouteCloseEndpoint();
      const state = observeAndForwardMobileRpcRouteCloses(client, nativeRouteCloseEndpoint(socket));
      const closed = once(socket, "close", { signal: AbortSignal.timeout(5_000) });
      client.emitClose(code, "peer released");
      assert.equal(state.closeForwardErrorName, null, "forwarding must use a DOM-sendable close code");
      const expectedCode = code === 1001 ? 1000 : code;
      const [event] = await closed;
      assert.equal(event.code, expectedCode);
      assert.equal((await peerClosed)[0], expectedCode);
      assert.equal(event.reason, code === 1001 ? "" : "peer released");
      assert.equal(state.closeCodeNormalized, code === 1001);
    });
  });
}

test("correlates each Gateway page RPC to one route ordinal and preserves the source records", () => {
  const pageSocket = { path: "/rpc", rpcOrdinal: 2, closedAtMs: null };
  const route = { socketOrdinal: 2, clientClosedAtMs: null, upstreamClosedAtMs: null };
  const pairs = correlateMobilePageRpcRoutes([
    { path: "/devtools", rpcOrdinal: null },
    { path: "/rpc", rpcOrdinal: 1, closedAtMs: 11 },
    pageSocket,
  ], [
    { socketOrdinal: 1, clientClosedAtMs: 10, upstreamClosedAtMs: 10 },
    route,
  ]);

  assert.equal(pairs.length, 2);
  assert.equal(pairs[1].pageSocket, pageSocket);
  assert.equal(pairs[1].routeDiagnostic, route);
});

test("fails closed when a page RPC has no route or ordinals are duplicated", () => {
  assert.throws(() => correlateMobilePageRpcRoutes(
    [{ path: "/rpc", rpcOrdinal: 3 }],
    [{ socketOrdinal: 2 }],
  ), /must map to one observed route socket ordinal/);
  assert.throws(() => correlateMobilePageRpcRoutes(
    [{ path: "/rpc", rpcOrdinal: 2 }],
    [{ socketOrdinal: 2 }, { socketOrdinal: 2 }],
  ), /must be unique/);
  assert.throws(() => correlateMobilePageRpcRoutes(
    [{ path: "/rpc", rpcOrdinal: 2 }, { path: "/rpc", rpcOrdinal: 2 }],
    [{ socketOrdinal: 2 }],
  ), /must be unique/);
  assert.throws(() => correlateMobilePageRpcRoutes(
    [{ path: "/rpc" }],
    [{ socketOrdinal: 1 }],
  ), /positive RPC ordinal/);
  assert.throws(() => correlateMobilePageRpcRoutes(
    [{ path: "/rpc", rpcOrdinal: 1 }],
    [{ socketOrdinal: 1 }, { socketOrdinal: 2 }],
  ), /exactly one observed route ordinal and vice versa/);
});

test("route close barrier requires both actual endpoints and ignores the advisory page close event", () => {
  const [pair] = correlateMobilePageRpcRoutes(
    [{ path: "/rpc", rpcOrdinal: 1, closedAtMs: null }],
    [{ socketOrdinal: 1, clientClosedAtMs: null, upstreamClosedAtMs: null }],
  );

  assert.equal(mobilePageRpcRoutesClosed([pair]), false);
  pair.pageSocket.closedAtMs = 12;
  assert.equal(mobilePageRpcRoutesClosed([pair]), false);
  pair.routeDiagnostic.clientClosedAtMs = 13;
  assert.equal(mobilePageRpcRoutesClosed([pair]), false);
  pair.routeDiagnostic.upstreamClosedAtMs = 14;
  assert.equal(mobilePageRpcRoutesClosed([pair]), true);
  assert.equal(mobilePageRpcRoutesClosed([]), false);
});

test("owned task page release closes the exact RPC endpoints before disposing its Page", async () => {
  let pageClosed = false;
  const pageSocket = { path: "/rpc", rpcOrdinal: 7, closedAtMs: null };
  const routeDiagnostic = { socketOrdinal: 7, clientClosedAtMs: null, upstreamClosedAtMs: null };
  const client = makeRouteCloseEndpoint();
  const upstream = makeRouteCloseEndpoint();
  routeDiagnostic.closeForwarding = observeAndForwardMobileRpcRouteCloses(client, upstream, {
    onClientClose: () => { routeDiagnostic.clientClosedAtMs = 11; },
    onUpstreamClose: () => { routeDiagnostic.upstreamClosedAtMs = 12; },
  });
  const result = await closePageRpcRoutesAndWait({
    page: { async close() { pageClosed = true; pageSocket.closedAtMs = 10; } },
    pageWebSockets: [pageSocket],
    routeDiagnostics: [routeDiagnostic],
    requiredSocketOrdinal: 7,
    expectedPageRpcCount: 1,
    expectedRouteCount: 1,
    readCurrentOrdinalCounts: () => ({ pageRpcCount: 1, routeCount: 1 }),
    waitFor: async (probe, _timeoutMs, description) => {
      assert.equal(pageClosed, false, "route close waiting must keep the Page dispatcher alive");
      assert.match(description, /client and upstream endpoint to close/);
      assert.deepEqual(client.closeRequests, [{ code: 1000, reason: "" }]);
      assert.deepEqual(upstream.closeRequests, [{ code: 1000, reason: "" }]);
      assert.equal(routeDiagnostic.closeForwarding.requestCloseFromOwnerRelease(), false,
        "repeated owner release must not duplicate endpoint close requests");
      await Promise.resolve();
      assert.equal(probe(), null, "settled requests still need both actual endpoint callbacks");
      client.emitClose(1001, "");
      upstream.emitClose(1001, "");
      assert.equal(probe(), true);
    },
  });
  assert.deepEqual(result, {
    pageClosed: true,
    rpcSocketCount: 1,
    allRouteEndpointsClosed: true,
    requiredSocketOrdinal: 7,
    requiredRouteEndpointsClosed: true,
  });
  assert.equal(pageClosed, true, "the Page is disposed only after both route callbacks arrive");
});

test("a new page or route ordinal during owner release fails closed and still disposes the Page", async () => {
  let pageClosed = false;
  let currentPageRpcCount = 1;
  let currentRouteCount = 1;
  const routeDiagnostic = { socketOrdinal: 1, clientClosedAtMs: null, upstreamClosedAtMs: null };
  routeDiagnostic.closeForwarding = observeAndForwardMobileRpcRouteCloses(
    makeRouteCloseEndpoint(), makeRouteCloseEndpoint());

  await assert.rejects(closePageRpcRoutesAndWait({
    page: { async close() { pageClosed = true; } },
    pageWebSockets: [{ path: "/rpc", rpcOrdinal: 1 }],
    routeDiagnostics: [routeDiagnostic],
    expectedPageRpcCount: 1,
    expectedRouteCount: 1,
    readCurrentOrdinalCounts: () => ({
      pageRpcCount: currentPageRpcCount,
      routeCount: currentRouteCount,
    }),
    waitFor: async probe => {
      assert.equal(pageClosed, false);
      currentPageRpcCount += 1;
      currentRouteCount += 1;
      await probe();
    },
  }), /new page RPC ordinal observed while waiting/);
  assert.equal(pageClosed, true, "an unexpected reconnect must not skip owner Page cleanup");
  assert.equal(routeDiagnostic.clientClosedAtMs, null);
  assert.equal(routeDiagnostic.upstreamClosedAtMs, null);
});

test("resolved close requests and an advisory page close cannot replace actual route callbacks", async () => {
  let pageClosed = false;
  const routeDiagnostic = { socketOrdinal: 3, clientClosedAtMs: null, upstreamClosedAtMs: null };
  const client = makeRouteCloseEndpoint();
  const upstream = makeRouteCloseEndpoint();
  routeDiagnostic.closeForwarding = observeAndForwardMobileRpcRouteCloses(client, upstream, {
    onClientClose: () => { routeDiagnostic.clientClosedAtMs = 1; },
    onUpstreamClose: () => { routeDiagnostic.upstreamClosedAtMs = 2; },
  });
  await assert.rejects(closePageRpcRoutesAndWait({
    page: { async close() { pageClosed = true; } },
    pageWebSockets: [{ path: "/rpc", rpcOrdinal: 3, closedAtMs: 2 }],
    routeDiagnostics: [routeDiagnostic],
    requiredSocketOrdinal: 3,
    waitFor: async probe => {
      assert.equal(pageClosed, false);
      assert.deepEqual(client.closeRequests, [{ code: 1000, reason: "" }]);
      assert.deepEqual(upstream.closeRequests, [{ code: 1000, reason: "" }]);
      assert.equal(probe(), null, "resolved close() requests do not establish endpoint closure");
      throw new Error("both owned route endpoints have not closed");
    },
  }), /both owned route endpoints have not closed/);
  assert.equal(pageClosed, true);
  assert.equal(routeDiagnostic.clientClosedAtMs, null);
  assert.equal(routeDiagnostic.upstreamClosedAtMs, null);
});

test("a close request rejection after actual endpoint callbacks keeps owner release failed", async () => {
  let pageClosed = false;
  let rejectClientClose;
  let resolveUpstreamClose;
  const client = makeRouteCloseEndpoint();
  const upstream = makeRouteCloseEndpoint();
  client.close = options => {
    client.closeRequests.push(options);
    return new Promise((_resolve, reject) => { rejectClientClose = reject; });
  };
  upstream.close = options => {
    upstream.closeRequests.push(options);
    return new Promise(resolve => { resolveUpstreamClose = resolve; });
  };
  const routeDiagnostic = { socketOrdinal: 4, clientClosedAtMs: null, upstreamClosedAtMs: null };
  routeDiagnostic.closeForwarding = observeAndForwardMobileRpcRouteCloses(client, upstream, {
    onClientClose: () => { routeDiagnostic.clientClosedAtMs = 4; },
    onUpstreamClose: () => { routeDiagnostic.upstreamClosedAtMs = 5; },
  });

  await assert.rejects(closePageRpcRoutesAndWait({
    page: { async close() { pageClosed = true; } },
    pageWebSockets: [{ path: "/rpc", rpcOrdinal: 4 }],
    routeDiagnostics: [routeDiagnostic],
    requiredSocketOrdinal: 4,
    waitFor: async probe => {
      await Promise.resolve();
      client.emitClose(1001, "");
      upstream.emitClose(1001, "");
      assert.equal(Number.isFinite(routeDiagnostic.clientClosedAtMs), true);
      assert.equal(Number.isFinite(routeDiagnostic.upstreamClosedAtMs), true);
      assert.equal(probe(), null, "actual callbacks cannot outrun pending close requests");
      resolveUpstreamClose();
      rejectClientClose(new Error("private asynchronous close rejection"));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(routeDiagnostic.closeForwarding.closeRequestPendingCount, 0);
      assert.equal(routeDiagnostic.closeForwarding.closeForwardErrorCount, 1);
      assert.equal(probe(), null, "a late close request rejection must block release");
      throw new Error("late endpoint close request rejection must fail owner release");
    },
  }), /late endpoint close request rejection must fail owner release/);
  assert.equal(pageClosed, true, "the Page still closes after a late close request rejection");
  assert.equal(mobilePageRpcRoutesClosed([{ routeDiagnostic }]), false);
  assert.equal(JSON.stringify(routeDiagnostic).includes("private asynchronous close rejection"), false,
    "asynchronous close error text must remain out of diagnostics");
});

test("owner release rechecks actual close state after disposing the Page", async () => {
  let pageClosed = false;
  const client = makeRouteCloseEndpoint();
  const upstream = makeRouteCloseEndpoint();
  const routeDiagnostic = { socketOrdinal: 5, clientClosedAtMs: null, upstreamClosedAtMs: null };
  routeDiagnostic.closeForwarding = observeAndForwardMobileRpcRouteCloses(client, upstream, {
    onClientClose: () => { routeDiagnostic.clientClosedAtMs = 5; },
    onUpstreamClose: () => { routeDiagnostic.upstreamClosedAtMs = 6; },
  });

  await assert.rejects(closePageRpcRoutesAndWait({
    page: { async close() {
      pageClosed = true;
      routeDiagnostic.closeForwarding.closeForwardErrorCount += 1;
    } },
    pageWebSockets: [{ path: "/rpc", rpcOrdinal: 5 }],
    routeDiagnostics: [routeDiagnostic],
    requiredSocketOrdinal: 5,
    waitFor: async probe => {
      await Promise.resolve();
      client.emitClose(1001, "");
      upstream.emitClose(1001, "");
      await Promise.resolve();
      assert.equal(probe(), true);
    },
  }), /close callbacks or close request settlement changed before Page disposal completed/);
  assert.equal(pageClosed, true);
});

test("a missing required page-to-route ordinal fails only after the owned page is closed", async () => {
  let pageClosed = false;
  await assert.rejects(closePageRpcRoutesAndWait({
    page: { async close() { pageClosed = true; } },
    pageWebSockets: [{ path: "/rpc", rpcOrdinal: 2, closedAtMs: null }],
    routeDiagnostics: [{ socketOrdinal: 1, clientClosedAtMs: 1, upstreamClosedAtMs: 1 }],
    requiredSocketOrdinal: 2,
    waitFor: async () => { throw new Error("should not wait for an unmatched route"); },
  }), /must map to one observed route socket ordinal/);
  assert.equal(pageClosed, true);
});

function makeRouteCloseEndpoint() {
  const endpoint = {
    closeHandler: null,
    closeRequests: [],
    closed: false,
    onClose(callback) { endpoint.closeHandler = callback; },
    close(options) {
      endpoint.closeRequests.push(options);
      return Promise.resolve();
    },
    emitClose(code, reason) {
      endpoint.closed = true;
      endpoint.closeHandler?.(code, reason);
    },
  };
  return endpoint;
}

test("forwards the first client close without treating close() resolution as actual upstream closure", async () => {
  const client = makeRouteCloseEndpoint();
  const upstream = makeRouteCloseEndpoint();
  const routeDiagnostic = { clientClosedAtMs: null, upstreamClosedAtMs: null };
  routeDiagnostic.closeForwarding = observeAndForwardMobileRpcRouteCloses(client, upstream, {
    onClientClose: () => { routeDiagnostic.clientClosedAtMs = 1; },
    onUpstreamClose: () => { routeDiagnostic.upstreamClosedAtMs = 2; },
  });

  client.emitClose(1000, "owner released");

  assert.equal(routeDiagnostic.clientClosedAtMs, 1);
  assert.deepEqual(upstream.closeRequests, [{ code: 1000, reason: "owner released" }],
    "legal close code and reason must pass through unchanged");
  assert.equal(upstream.closed, false, "a resolved close request is not an actual close callback");
  assert.equal(mobilePageRpcRoutesClosed([{ routeDiagnostic }]), false);
  upstream.emitClose(1000, "owner released");
  await Promise.resolve();
  assert.equal(routeDiagnostic.upstreamClosedAtMs, 2);
  assert.equal(mobilePageRpcRoutesClosed([{ routeDiagnostic }]), true);
  assert.equal(client.closeRequests.length, 0, "the peer close callback must not echo a second close request");
});

test("forwards an upstream close back to the client once and normalizes reserved close codes", () => {
  const client = makeRouteCloseEndpoint();
  const upstream = makeRouteCloseEndpoint();
  const closeForwarding = observeAndForwardMobileRpcRouteCloses(client, upstream);

  upstream.emitClose(1006, "abnormal closure");

  assert.deepEqual(client.closeRequests, [{ code: 1000, reason: "" }],
    "reserved wire close codes and reasons must be normalized for the DOM close API");
  assert.equal(closeForwarding.firstCloseEndpoint, "upstream");
  assert.equal(closeForwarding.closeCodeNormalized, true);
  assert.equal(closeForwarding.closeReasonNormalized, true);
  assert.equal(client.closed, false, "requesting the peer close must not invent its close event");
  client.emitClose(1001, "");
  assert.equal(client.closeRequests.length, 1, "the actual client close event must not echo the request");
});

test("records asynchronous close forwarding errors and keeps actual closure unproven", async () => {
  const client = makeRouteCloseEndpoint();
  const upstream = makeRouteCloseEndpoint();
  upstream.close = () => Promise.reject(new Error("private close reason"));
  const routeDiagnostic = { clientClosedAtMs: null, upstreamClosedAtMs: null };
  routeDiagnostic.closeForwarding = observeAndForwardMobileRpcRouteCloses(client, upstream, {
    onClientClose: () => { routeDiagnostic.clientClosedAtMs = 1; },
    onUpstreamClose: () => { routeDiagnostic.upstreamClosedAtMs = 2; },
  });

  client.emitClose(1000, "owner released");
  await Promise.resolve();

  assert.equal(routeDiagnostic.closeForwarding.requestStatus, "failed");
  assert.equal(routeDiagnostic.closeForwarding.closeForwardErrorCount, 1);
  assert.equal(routeDiagnostic.closeForwarding.closeForwardErrorName, "Error");
  assert.equal(JSON.stringify(routeDiagnostic).includes("private close reason"), false,
    "close error text must stay out of diagnostics");
  assert.equal(mobilePageRpcRoutesClosed([{ routeDiagnostic }]), false);
});

test("rejects a close reason that exceeds the WebSocket limit without claiming peer closure", () => {
  const client = makeRouteCloseEndpoint();
  const upstream = makeRouteCloseEndpoint();
  const routeDiagnostic = { clientClosedAtMs: null, upstreamClosedAtMs: null };
  routeDiagnostic.closeForwarding = observeAndForwardMobileRpcRouteCloses(client, upstream, {
    onClientClose: () => { routeDiagnostic.clientClosedAtMs = 1; },
  });

  client.emitClose(3001, "é".repeat(62));

  assert.equal(upstream.closeRequests.length, 0);
  assert.equal(routeDiagnostic.closeForwarding.requestStatus, "failed");
  assert.equal(routeDiagnostic.closeForwarding.closeForwardErrorName, "RangeError");
  assert.equal(routeDiagnostic.upstreamClosedAtMs, null);
  assert.equal(mobilePageRpcRoutesClosed([{ routeDiagnostic }]), false);
});

test("route close barrier rejects either bounded history when its ordinal window was truncated", async () => {
  let pageClosed = false;
  await assert.rejects(closePageRpcRoutesAndWait({
    page: { async close() { pageClosed = true; } },
    pageWebSockets: [
      { path: "/rpc", rpcOrdinal: 2 },
      { path: "/rpc", rpcOrdinal: 3 },
    ],
    routeDiagnostics: [
      { socketOrdinal: 2 },
      { socketOrdinal: 3 },
    ],
    expectedPageRpcCount: 3,
    expectedRouteCount: 3,
    waitFor: async () => { throw new Error("must not wait on truncated evidence"); },
  }), /history was truncated/);
  assert.equal(pageClosed, true, "truncated-history failure must happen after owned page cleanup");
});
