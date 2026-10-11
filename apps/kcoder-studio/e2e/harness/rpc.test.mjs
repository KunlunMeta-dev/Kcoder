import test from "node:test";
import assert from "node:assert/strict";
import { closeRpcAndWait, isTurnCompletion } from "./rpc.mjs";

test("completion matching never reuses another thread with the same local turn ID", () => {
  const first = {
    method: "turn/completed",
    params: { threadId: "first", turnId: "turn-1" },
  };
  assert.equal(isTurnCompletion(first, "first", "turn-1"), true);
  assert.equal(isTurnCompletion(first, "second", "turn-1"), false);
  assert.equal(isTurnCompletion(first, "first", "turn-2"), false);
  assert.equal(
    isTurnCompletion({ method: "turn/completed" }, undefined, undefined),
    false,
  );
});

test("Node RPC close helper waits for the WebSocket close event", async () => {
  class FakeSocket {
    static CLOSED = 3;
    readyState = 1;
    listeners = new Map();
    addEventListener(type, callback) {
      const callbacks = this.listeners.get(type) ?? new Set();
      callbacks.add(callback);
      this.listeners.set(type, callbacks);
    }
    removeEventListener(type, callback) {
      this.listeners.get(type)?.delete(callback);
    }
    close() {
      this.readyState = FakeSocket.CLOSED;
      for (const callback of this.listeners.get("close") ?? []) callback();
    }
  }
  const socket = new FakeSocket();
  let closeRequested = false;
  await closeRpcAndWait({ socket, close() { closeRequested = true; socket.close(); } }, "fixture RPC", 100);
  assert.equal(closeRequested, true);
  assert.equal(socket.readyState, FakeSocket.CLOSED);
});
