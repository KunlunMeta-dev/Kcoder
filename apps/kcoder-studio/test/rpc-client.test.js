import assert from "node:assert/strict";
import test from "node:test";
import { RpcClient, RpcError, defaultRpcUrl, rpcUrlForServer } from "../src/rpc-client.js";

if (!globalThis.CustomEvent) globalThis.CustomEvent = class CustomEvent extends Event { constructor(type, options) { super(type); this.detail = options?.detail; } };

class FakeSocket extends EventTarget {
  static instances = [];
  readyState = 0;
  sent = [];
  constructor(url) { super(); this.url = url; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  send(data) { this.sent.push(JSON.parse(data)); }
  receive(data) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

test("builds same-origin websocket URLs", () => {
  assert.equal(defaultRpcUrl({ protocol: "http:", host: "localhost:4173" }), "ws://localhost:4173/rpc");
  assert.equal(defaultRpcUrl({ protocol: "https:", host: "studio.example" }), "wss://studio.example/rpc");
  assert.equal(
    defaultRpcUrl(
      { protocol: "http:", host: "127.0.0.1:4173" },
      { querySelector: () => ({ content: "secret token" }) }
    ),
    "ws://127.0.0.1:4173/rpc?token=secret%20token"
  );
});

test("routes a websocket to a selected server", () => {
  assert.equal(
    rpcUrlForServer("ws://localhost:4173/rpc?token=abc", "build-01"),
    "ws://localhost:4173/rpc?token=abc&server=build-01"
  );
});

test("correlates JSON-RPC requests and responses", async () => {
  const client = new RpcClient("ws://test/rpc", FakeSocket);
  client.connect(); const socket = FakeSocket.instances.at(-1); socket.open();
  const resultPromise = client.request("initialize", { clientInfo: { name: "test" } });
  assert.deepEqual(socket.sent[0], { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "test" } } });
  socket.receive({ jsonrpc: "2.0", id: 1, result: { ready: true } });
  assert.deepEqual(await resultPromise, { ready: true });
});

test("dispatches notifications without coupling method names", () => {
  const client = new RpcClient("ws://test/rpc", FakeSocket); client.connect(); const socket = FakeSocket.instances.at(-1); socket.open();
  let received; client.addEventListener("notification", (event) => { received = event.detail; });
  socket.receive({ jsonrpc: "2.0", method: "item/delta", params: { delta: "hello" } });
  assert.equal(received.method, "item/delta"); assert.equal(received.params.delta, "hello");
});

test("rejects pending work on disconnect", async () => {
  const client = new RpcClient("ws://test/rpc", FakeSocket); client.connect(); const socket = FakeSocket.instances.at(-1); socket.open();
  const pending = client.request("turn/start"); socket.close();
  await assert.rejects(pending, (error) => error instanceof RpcError && error.message === "连接已断开");
});

test("ignores a stale close after reconnect", async () => {
  const client = new RpcClient("ws://test/rpc", FakeSocket);
  client.connect(); const oldSocket = FakeSocket.instances.at(-1); oldSocket.open();
  oldSocket.readyState = 2;
  client.connect(); const newSocket = FakeSocket.instances.at(-1); newSocket.open();
  const pending = client.request("initialize");
  oldSocket.dispatchEvent(new Event("close"));
  assert.equal(client.connected, true);
  newSocket.receive({ jsonrpc: "2.0", id: 1, result: { ready: true } });
  assert.deepEqual(await pending, { ready: true });
});

test("settles old requests before replacing a closing connection", async () => {
  const client = new RpcClient("ws://test/rpc", FakeSocket);
  client.connect(); const oldSocket = FakeSocket.instances.at(-1); oldSocket.open();
  let oldError;
  const oldRequest = client.request("turn/start").catch((error) => { oldError = error; });
  oldSocket.readyState = 2;
  client.connect(); const newSocket = FakeSocket.instances.at(-1); newSocket.open();
  await Promise.resolve();
  assert.ok(oldError instanceof RpcError, "旧连接的请求必须立即失败");
  await oldRequest;
  const newRequest = client.request("initialize");
  oldSocket.receive({ jsonrpc: "2.0", id: 2, result: "stale" });
  oldSocket.dispatchEvent(new Event("close"));
  newSocket.receive({ jsonrpc: "2.0", id: 2, result: "current" });
  assert.equal(await newRequest, "current");
  client.close();
});

test("rejects non-object JSON envelopes and continues receiving responses", async () => {
  const client = new RpcClient("ws://test/rpc", FakeSocket);
  client.connect(); const socket = FakeSocket.instances.at(-1); socket.open();
  const errors = [];
  client.addEventListener("protocolerror", (event) => errors.push(event.detail));
  for (const value of [null, [], true, 42, "text"]) socket.receive(value);
  assert.equal(errors.length, 5);
  const request = client.request("initialize");
  socket.receive({ jsonrpc: "2.0", id: 1, result: null });
  assert.equal(await request, null);
  client.close();
});
