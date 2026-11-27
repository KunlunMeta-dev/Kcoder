import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { QQGateway } from '../src/adapters/qq-sdk.mjs';
import { BoundedPlatformEvents, PLATFORM_FRAME_BYTES } from '../src/adapters/sdk-guards.mjs';

test('real SDK socket keeps bounded frames and RESUME behind committed ingress', { timeout: 10000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const controller = new AbortController(), events = new BoundedPlatformEvents();
  let release, entered, ready, allReceived;
  const gate = new Promise(resolve => { release = resolve; });
  const first = new Promise(resolve => { entered = resolve; });
  const connected = new Promise(resolve => { ready = resolve; });
  const received = new Promise(resolve => { allReceived = resolve; });
  const messages = [];
  let peer;
  server.on('connection', socket => {
    peer = socket; socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on('message', raw => {
      const packet = JSON.parse(raw);
      if (packet.op === 2) socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'fixture-session' } }));
      if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }));
    });
  });
  const gateway = new QQGateway({ account: { accountId: 'fixture', appId: 'fixture', clientSecret: 'fixture' }, events,
    abortSignal: controller.signal, reconnect: { maxAttempts: 0 },
    getAccessToken: async () => 'fixture', getGatewayUrl: async () => `ws://127.0.0.1:${server.address().port}`,
    onReady: ready, onMessage: async message => {
      messages.push(message.messageId);
      if (message.messageId === 'first') { entered(); await gate; }
      if (message.messageId === 'second') allReceived();
    },
  });
  const loop = gateway.start();
  t.after(async () => {
    release(); events.close(); controller.abort(); await loop;
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  await connected;
  assert.equal(gateway.currentWs._receiver._maxPayload, PLATFORM_FRAME_BYTES);
  for (const [index, id] of ['first', 'second'].entries()) peer.send(JSON.stringify({
    op: 0, t: 'C2C_MESSAGE_CREATE', s: index + 2,
    d: { id, author: { user_openid: 'fixture-user' }, content: id, timestamp: new Date().toISOString() },
  }));
  await first;
  assert.deepEqual(messages, ['first']); assert.equal(gateway.lastSeq, 1);
  release(); await received; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(messages, ['first', 'second']); assert.equal(gateway.lastSeq, 3);
});
