import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import {
  createPageRpcBridgeConnection,
  installRpcResponseReceiptWitness,
  isExactThreadInvalidationSnapshot,
  isOwnedIndexedAuthorityResponse,
  parseRpcFrame,
  registerPageRpcWebSocketRoute,
} from "./mobile-session-cache-multirealm-helpers.mjs";

function fakeRouteSocket() {
  return {
    closeHandler: null,
    messageHandler: null,
    closeCount: 0,
    sent: [],
    onClose(handler) { this.closeHandler = handler; },
    onMessage(handler) { this.messageHandler = handler; },
    async close() {
      this.closeCount++;
      this.closeHandler?.();
    },
    send(message) { this.sent.push(message); },
  };
}

test("Mobile RPC bridge route registration settles before the installer returns", async () => {
  let finishRegistration;
  let routePattern = null;
  let installedHandler = null;
  let installerSettled = false;
  const registration = new Promise(resolve => { finishRegistration = resolve; });
  const page = {
    routeWebSocket(pattern, handler) {
      routePattern = pattern;
      installedHandler = handler;
      return registration;
    },
  };
  const handler = () => {};
  const installing = registerPageRpcWebSocketRoute(page, handler).then(() => {
    installerSettled = true;
  });

  await Promise.resolve();
  assert.equal(routePattern, "**/rpc*");
  assert.equal(installedHandler, handler);
  assert.equal(installerSettled, false,
    "the caller must not navigate while the Playwright route-registration Promise is pending");

  finishRegistration();
  await installing;
  assert.equal(installerSettled, true);
});

test("Browser RPC receipt witness keeps only response IDs and exact raw-frame hashes", async () => {
  let installer;
  await installRpcResponseReceiptWitness({
    async addInitScript(script) { installer = script; },
  });
  assert.equal(typeof installer, "function");

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.handler = null;
      this.listeners = [];
    }

    addEventListener(type, listener) {
      if (type === "message") this.listeners.push(listener);
    }

    dispatchMessage(data) {
      const event = { type: "message", data };
      this.handler?.call(this, event);
      for (const listener of this.listeners) listener.call(this, event);
    }
  }
  Object.defineProperty(FakeWebSocket.prototype, "onmessage", {
    configurable: true,
    enumerable: true,
    get() { return this.handler; },
    set(handler) { this.handler = handler; },
  });

  const sandbox = { WebSocket: FakeWebSocket, URL, crypto: webcrypto, TextEncoder };
  runInNewContext(`(${installer.toString()})()`, sandbox);
  const rpcSocket = new FakeWebSocket("ws://127.0.0.1/rpc?token=must-not-be-recorded");
  const rpcFramesSeenByApplication = [];
  rpcSocket.onmessage = event => rpcFramesSeenByApplication.push(event.data);
  const response = JSON.stringify({ jsonrpc: "2.0", id: 17, result: { rpcToken: "must-not-be-recorded" } });
  rpcSocket.dispatchMessage(response);
  rpcSocket.dispatchMessage(JSON.stringify({ jsonrpc: "2.0", method: "notice", params: {} }));

  const nonRpcSocket = new FakeWebSocket("ws://127.0.0.1/events");
  nonRpcSocket.onmessage = () => {};
  nonRpcSocket.dispatchMessage(response);
  for (let attempt = 0; attempt < 20 && sandbox.__mobileMultirealmRpcResponseReceiptsV1.length === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.deepEqual(rpcFramesSeenByApplication, [
    response,
    JSON.stringify({ jsonrpc: "2.0", method: "notice", params: {} }),
  ], "the witness must preserve the application's assigned onmessage handler");
  const receipts = sandbox.__mobileMultirealmRpcResponseReceiptsV1;
  assert.equal(receipts.length, 1, "only the RPC response frame should produce a witness");
  assert.equal(receipts[0].id, "17");
  assert.equal(receipts[0].sha256, createHash("sha256").update(response).digest("hex"));
  assert.equal(JSON.stringify(receipts).includes("must-not-be-recorded"), false,
    "the witness must not retain response bodies or credentials");
});

test("held authority can reach the live page after only the Gateway side closes", async () => {
  const pageSocket = fakeRouteSocket();
  const serverSocket = fakeRouteSocket();
  const connection = createPageRpcBridgeConnection(pageSocket, serverSocket);
  const heldResponse = JSON.stringify({ jsonrpc: "2.0", id: "indexed-7", result: { messages: [] } });

  assert.equal(await connection.disconnectServerPreservingPage(), true);
  assert.equal(connection.state.serverClosed, true);
  assert.equal(connection.state.serverCloseRequested, true);
  assert.equal(connection.state.clientClosed, false,
    "the intentional Gateway-side close must not close the Browser page-side route");
  assert.equal(serverSocket.closeCount, 1);
  assert.equal(pageSocket.closeCount, 0);

  assert.equal(connection.sendToServer("late client frame"), false,
    "frames from the live page must not be sent to the closed Gateway side");
  assert.equal(connection.state.droppedPageFramesAfterServerClose, 1);
  assert.equal(connection.sendToPage(heldResponse), true,
    "the exact held response must still be deliverable through the open page-side route");
  assert.deepEqual(pageSocket.sent, [heldResponse]);
  assert.equal(connection.state.clientClosed, false);
});

test("an unrequested Gateway-side close still closes the page-side route", () => {
  const pageSocket = fakeRouteSocket();
  const serverSocket = fakeRouteSocket();
  const connection = createPageRpcBridgeConnection(pageSocket, serverSocket);

  serverSocket.closeHandler?.();
  assert.equal(connection.state.serverClosed, true);
  assert.equal(connection.state.serverCloseRequested, false);
  assert.equal(pageSocket.closeCount, 1,
    "unexpected Gateway disconnects must preserve the bridge's normal close propagation");
  assert.equal(connection.state.clientClosed, true);
});

test("indexed authority requires exact request ID, method, thread ownership and a valid page range", () => {
  const request = { id: 17, method: "thread/read/indexed", threadId: "thread-target" };
  const response = { id: 17, result: { thread: { id: "thread-target" }, rangeStart: 4, rangeEnd: 5, messages: [{ id: "row-1" }] } };
  assert.equal(isOwnedIndexedAuthorityResponse(request, response, "thread-target"), true);
  assert.equal(isOwnedIndexedAuthorityResponse(request, { ...response, id: 18 }, "thread-target"), false);
  assert.equal(isOwnedIndexedAuthorityResponse(request, response, "thread-peer"), false);
  assert.equal(isOwnedIndexedAuthorityResponse({ ...request, method: "thread/resume" }, response, "thread-target"), false);
  assert.equal(isOwnedIndexedAuthorityResponse(request, { id: 17, error: { code: -32022 } }, "thread-target"), false);
  assert.equal(isOwnedIndexedAuthorityResponse(request, { id: 17, result: { thread: { id: "thread-target" }, rangeStart: 4, rangeEnd: 8, messages: [{ id: "row-1" }] } }, "thread-target"), false);
});

test("RPC frame parsing accepts text and bytes but rejects non-JSON frames", () => {
  const text = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { ok: true } });
  assert.deepEqual(parseRpcFrame(text), { jsonrpc: "2.0", id: 3, result: { ok: true } });
  assert.deepEqual(parseRpcFrame(Buffer.from(text)), { jsonrpc: "2.0", id: 3, result: { ok: true } });
  assert.equal(parseRpcFrame("not-json"), null);
  assert.equal(parseRpcFrame(null), null);
});

test("cache CAS evidence requires the exact tombstone and removal of the old slot revision", () => {
  const before = { key: "target-key", slot: 2, dataRevision: 7 };
  const snapshot = {
    ready: true,
    manifest: { lastKey: "peer-key", invalidations: [{ key: "t:target-key", revision: 10 }] },
    entries: [{ key: "peer-key", slot: 1 }],
    slotRevisions: [{ slot: 1, revision: 9 }, { slot: 2, revision: null }],
  };
  assert.equal(isExactThreadInvalidationSnapshot(snapshot, before), true);
  assert.equal(isExactThreadInvalidationSnapshot({
    ...snapshot,
    manifest: { lastKey: "peer-key", invalidations: [{ key: "t:other-key", revision: 10 }] },
  }, before), false);
  assert.equal(isExactThreadInvalidationSnapshot({
    ...snapshot,
    slotRevisions: [{ slot: 2, revision: before.dataRevision }],
  }, before), false);
  assert.equal(isExactThreadInvalidationSnapshot({
    ...snapshot,
    entries: [{ key: before.key, slot: before.slot }],
  }, before), false);
});
