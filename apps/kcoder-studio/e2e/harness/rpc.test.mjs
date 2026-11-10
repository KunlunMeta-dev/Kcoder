import test from "node:test";
import assert from "node:assert/strict";
import { closeRpcAndWait, isTurnCompletion, openPageGatewayRpc, rpcClient } from "./rpc.mjs";

for (const fallback of [false, true]) test(`owned page RPC uses the actual ${fallback ? 'Electron CDP' : 'context'} session cookie`, async () => {
  const secrets = [], events = [];
  const cookies = [{ name: 'owned_session', value: 'private-fixture-cookie' }];
  const browserContext = {
    cookies: async url => { assert.equal(url, 'http://127.0.0.1:12345'); return fallback ? [] : cookies; },
    newCDPSession: async page => {
      assert.equal(page, fixturePage);
      return { send: async (method, params) => { events.push(method); assert.deepEqual(params, { urls: ['http://127.0.0.1:12345'] }); return { cookies }; }, detach: async () => events.push('detach') };
    },
  };
  const fixturePage = { locator: () => ({ getAttribute: async () => 'private-fixture-token' }), context: () => browserContext };
  const rpc = { socket: { readyState: 3 } };
  const result = await openPageGatewayRpc({ registerSecret: value => secrets.push(value), addCleanup: () => {} }, fixturePage,
    { baseUrl: 'http://127.0.0.1:12345', wsUrl: 'ws://127.0.0.1:12345' }, 'owned reader', {
      open: async (url, options) => { assert.equal(new URL(url).searchParams.get('token'), secrets[0]); assert.equal(options.headers.Cookie, 'owned_session=private-fixture-cookie'); return rpc; },
    });
  assert.equal(result, rpc);
  assert.deepEqual(secrets, ['private-fixture-token', 'owned_session=private-fixture-cookie']);
  assert.deepEqual(events, fallback ? ['Network.getCookies', 'detach'] : []);
});

test('empty owned session fails without opening RPC and always detaches CDP', async () => {
  let detached = false;
  await assert.rejects(openPageGatewayRpc({ registerSecret: () => {} }, {
    locator: () => ({ getAttribute: async () => 'private-fixture-token' }),
    context: () => ({ cookies: async () => [], newCDPSession: async () => ({ send: async () => ({ cookies: [] }), detach: async () => { detached = true; } }) }),
  }, { baseUrl: 'http://127.0.0.1:12345' }, 'owned reader', { open: () => assert.fail('must not open without the real session') }), /session cookie is unavailable/);
  assert.equal(detached, true);
});

test('closed RPC settles original pending calls and waits without retrying or discarding observed history', async () => {
  class Socket extends EventTarget {
    sent = [];
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const socket = new Socket();
  const client = rpcClient(socket);
  const observed = { method: 'turn/completed', params: { threadId: 'original', turnId: 'owned' } };
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(observed) }));
  const original = client.request('turn/start', { threadId: 'original' }, 30000);
  const waiting = client.waitFor(message => message.method === 'missing', 30000, 'original event');
  const rejected = [assert.rejects(original, /outcome is unknown/), assert.rejects(waiting, /outcome is unknown/)];
  socket.close();
  await Promise.all(rejected);
  await assert.rejects(client.request('turn/start', {}), /connection closed/);
  await assert.rejects(client.waitFor(() => false, 30000, 'late event'), /connection closed/);
  assert.deepEqual(await client.waitFor(message => message === client.messages()[0], 10, 'already received'), observed);
  assert.equal(socket.sent.length, 1, 'Lost replies never trigger a new send');
});

test('an RPC transport error settles pending work even before a close notification', async () => {
  const socket = new EventTarget();
  socket.send = () => {};
  const client = rpcClient(socket);
  const rejected = assert.rejects(client.request('initialize'), /outcome is unknown/);
  socket.dispatchEvent(new Event('error'));
  await rejected;
  socket.dispatchEvent(new Event('close'));
});

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
