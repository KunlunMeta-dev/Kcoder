// Real owned server/client/data-WebSocket/TCP chain; synthetic Gateway, no model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { connect, Server } from 'node:net';
import { Duplex, getDefaultHighWaterMark, setDefaultHighWaterMark } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { startRelay } from '../src/server.mjs';
import { startClient } from '../src/client.mjs';
import { isolatedGatewayAuthority } from '../src/gateway-origin.mjs';
import { RELAY_EOF_DRAIN_TIMEOUT_MS } from '../src/transport.mjs';

async function bounded(promise, ms = 4000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned server transport deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t) {
  const id = 'owned-raw', authority = 'relay-raw-review.test';
  const host = isolatedGatewayAuthority(authority, id);
  const controlSecret = randomBytes(32).toString('hex'), gatewaySecret = randomBytes(32).toString('hex');
  const session = { accessToken: randomBytes(32).toString('hex'), rpcToken: randomBytes(32).toString('hex'), expiresAt: Date.now() + 120000 };
  const payload = Buffer.alloc(8 * 1024 * 1024, 0xa5);
  let replyStarted;
  const startedReply = new Promise(resolve => { replyStarted = resolve; });
  const gatewaySockets = new Set(), upgrades = [];
  const gateway = createServer(async (incoming, response) => {
    if (incoming.method === 'POST' && incoming.url === '/api/mobile/session') {
      for await (const _ of incoming) {}
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(session)); return;
    }
    response.writeHead(404); response.end();
  });
  gateway.on('connection', socket => { gatewaySockets.add(socket); socket.once('close', () => gatewaySockets.delete(socket)); });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  gateway.on('upgrade', (incoming, socket, head) => {
    upgrades.push({ mount: incoming.headers['x-kcoder-mobile-mount'], proof: incoming.headers['x-kcoder-mobile-mount-proof'] });
    assert.equal(incoming.headers.authorization, `Bearer ${session.accessToken}`);
    wss.handleUpgrade(incoming, socket, head, peer => wss.emit('connection', peer));
  });
  wss.on('connection', peer => {
    peer.on('error', () => {});
    peer.once('message', () => {
      peer.send(payload, { binary: true }, () => peer.close(1000));
      replyStarted(peer.bufferedAmount);
    });
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const relay = await startRelay({ gateways: [{ id, secret: controlSecret, gatewaySecret,
    maxConnections: 8, maxBytesPerWindow: 32 * 1024 * 1024, trafficWindowMs: 60000 }],
    sharedHosts: [authority], controlPort: 0, proxyPort: 0, connectTimeout: 1000 });
  let online;
  const ready = new Promise(resolve => { online = resolve; });
  const clientOwners = new Set();
  let clientOwnersClosed;
  const client = startClient({ url: `http://127.0.0.1:${relay.controlPort}`, gatewayId: id, secret: controlSecret,
    gateway: `http://127.0.0.1:${gateway.address().port}`, allowInsecure: true, retryMs: 30, onOnline: online,
    onDiagnostic(value) {
      if (!['control_connecting', 'data_connecting', 'control_close', 'data_close'].includes(value.event)) return;
      const key = `${value.event.startsWith('control_') ? 'control' : 'data'}:${value.generation}:${value.correlation ?? ''}`;
      if (value.event.endsWith('_connecting')) clientOwners.add(key);
      else clientOwners.delete(key);
      if (clientOwners.size === 0) clientOwnersClosed?.();
    } });
  const frontends = new Set(), rawFrontends = new Set();
  t.after(async () => {
    const closedOwners = [...frontends, ...rawFrontends, ...wss.clients, ...gatewaySockets].map(owner =>
      owner.closed || owner.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise(resolve => owner.once('close', resolve)));
    client.close(); for (const ws of frontends) ws.terminate(); for (const ws of wss.clients) ws.terminate();
    for (const socket of rawFrontends) socket.destroy();
    await relay.close(); gateway.closeAllConnections();
    for (const socket of gatewaySockets) socket.destroy();
    await bounded(new Promise(resolve => gateway.close(resolve)));
    await bounded(new Promise(resolve => wss.close(resolve)));
    await bounded(Promise.all(closedOwners));
    if (clientOwners.size > 0) await bounded(new Promise(resolve => { clientOwnersClosed = resolve; }));
    assert.equal(frontends.size, 0); assert.equal(rawFrontends.size, 0);
    assert.equal(gatewaySockets.size, 0); assert.equal(wss.clients.size, 0); assert.equal(clientOwners.size, 0);
  });
  await bounded(ready);
  const paired = await bounded(new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: relay.proxyPort, method: 'POST', path: `/g/${id}/api/mobile/session`,
      headers: { host, 'content-type': 'application/json' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode)); response.once('error', reject);
    });
    outgoing.once('error', reject); outgoing.end('{"token":"owned-pairing"}');
  }));
  assert.equal(paired, 200);
  return { payload, client, relay, upgrades, startedReply, openRaw: async () => {
    const socket = connect({ host: '127.0.0.1', port: relay.proxyPort, allowHalfOpen: true, highWaterMark: 64 * 1024 });
    rawFrontends.add(socket); socket.on('error', () => {}); socket.once('close', () => rawFrontends.delete(socket));
    await bounded(once(socket, 'connect')); socket.pause();
    const headers = `GET /g/${id}/rpc?token=${session.rpcToken} HTTP/1.1\r\nHost: ${host}\r\nOrigin: https://${host}\r\nAuthorization: Bearer ${session.accessToken}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`;
    const masked = (opcode, bytes) => {
      const mask = randomBytes(4), payload = Buffer.from(bytes);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % mask.length];
      return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, payload]);
    };
    socket.write(Buffer.concat([Buffer.from(headers), masked(1, 'owned-tail-request'), masked(8, Buffer.from([3, 232]))]));
    return socket;
  }, open: async (extraHeaders = {}) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.proxyPort}/g/${id}/rpc?token=${session.rpcToken}`, {
      perMessageDeflate: false, headers: { host, origin: `https://${host}`, authorization: `Bearer ${session.accessToken}`, ...extraHeaders },
    });
    frontends.add(ws); ws.on('error', () => {}); ws.once('close', () => frontends.delete(ws));
    await bounded(once(ws, 'open')); return ws;
  } };
}

test('actual server and createWebSocketStream chain preserves a large binary reply to a paused reader', async t => {
  const f = await fixture(t), ws = await f.open();
  const message = once(ws, 'message'), closed = new Promise(resolve => ws.once('close', code => resolve(code)));
  ws._socket.pause();
  ws.send('owned-tail-request');
  let timer = setTimeout(() => ws._socket.resume(), 100);
  t.after(() => clearTimeout(timer));
  const [data, binary] = await bounded(message);
  assert.equal(binary, true); assert.deepEqual(data, f.payload);
  assert.equal(await bounded(closed), 1000, 'the actual application close frame must also survive');
});

test('actual control-owner revocation closes a paused raw connection without waiting for a drain deadline', async t => {
  const f = await fixture(t), ws = await f.open();
  const closed = new Promise(resolve => ws.once('close', resolve));
  ws._socket.pause(); ws.send('owned-tail-request');
  assert.ok(await bounded(f.startedReply) > 0, 'the owned Gateway has queued reply bytes before revocation');
  const start = performance.now(); f.client.close(); ws._socket.resume();
  await bounded(closed, 1500);
  assert.ok(performance.now() - start < 1500);
});

test('a valid RPC upgrade cannot forward client-supplied internal mobile mount headers', async t => {
  const f = await fixture(t);
  const ws = await f.open({ 'x-kcoder-mobile-mount': '/g/foreign', 'x-kcoder-mobile-mount-proof': 'PRIVATE_MOUNT_CANARY' });
  assert.equal(f.upgrades.length, 1);
  assert.deepEqual(f.upgrades[0], { mount: undefined, proof: undefined });
  const closed = new Promise(resolve => ws.once('close', resolve)); ws.close(); await bounded(closed);
});

async function pendingEndedRawConsumer(t) {
  const previous = getDefaultHighWaterMark(false);
  // This public Node setting lets the owned TCP sink queue a complete reply
  // while the actual data-WebSocket source reaches its own EOF and finish.
  setDefaultHighWaterMark(false, 32 * 1024 * 1024);
  t.after(() => setDefaultHighWaterMark(false, previous));
  const f = await fixture(t);
  const originalEmit = Server.prototype.emit;
  let sink, sourceReady, firstEofAt;
  const sourceEnded = new Promise(resolve => { sourceReady = resolve; });
  Server.prototype.emit = function (event, ...args) {
    if (event === 'connection' && this.address()?.port === f.relay.proxyPort && !sink) {
      sink = args[0];
      sink.once('pipe', gate => gate.once('unpipe', source => {
        firstEofAt = performance.now(); sourceReady(source);
      }));
    }
    return originalEmit.call(this, event, ...args);
  };
  t.after(() => { Server.prototype.emit = originalEmit; });
  const frontend = await f.openRaw();
  const source = await bounded(sourceEnded);
  assert.equal(source.readableEnded, true);
  const finished = source.writableFinished ? Promise.resolve() : new Promise(resolve => source.once('finish', resolve));
  frontend.end(); await bounded(finished);
  assert.equal(source.writableFinished, true);
  t.diagnostic(JSON.stringify({ queued: sink.writableLength, sinkDestroyed: sink.destroyed,
    sinkFinished: sink.writableFinished, frontendBuffered: frontend.readableLength,
    sourceEnded: source.readableEnded, sourceFinished: source.writableFinished }));
  assert.ok(sink.writableLength > 0, 'causal gate: the original TCP owner still has queued bytes');
  assert.equal(sink.destroyed, false);
  return { f, sink, firstEofAt };
}

test('late owner revocation aborts a queued raw sink after both source halves have completed', async t => {
  const { f, sink } = await pendingEndedRawConsumer(t);
  for (let i = 0; i < 7; i++) await f.open();
  await assert.rejects(f.open(), /Unexpected server response: 503/,
    'the pending raw consumer must still occupy the original eighth connection');
  const ended = new Promise(resolve => sink.once('close', resolve));
  let closes = 0; sink.on('close', () => closes++);
  const began = performance.now(); f.client.close(); f.client.close();
  await bounded(ended, 1500);
  assert.ok(performance.now() - began < 1500);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closes, 1);
});

test('the actual raw owner keeps its first EOF deadline and releases exactly its capacity', async t => {
  const { f, sink, firstEofAt } = await pendingEndedRawConsumer(t);
  let closes = 0; sink.on('close', () => closes++);
  await bounded(new Promise(resolve => sink.once('close', resolve)), RELAY_EOF_DRAIN_TIMEOUT_MS + 1500);
  const elapsed = performance.now() - firstEofAt;
  assert.ok(elapsed >= RELAY_EOF_DRAIN_TIMEOUT_MS - 150);
  assert.ok(elapsed < RELAY_EOF_DRAIN_TIMEOUT_MS + 1500);
  assert.equal(sink.destroyed, true); assert.equal(closes, 1);
  for (let i = 0; i < 8; i++) await f.open();
  await assert.rejects(f.open(), /Unexpected server response: 503/,
    'the timed-out raw owner releases one slot without widening the eight-connection cap');
});

test('an original owner aborts a pending raw handshake and a late callback cannot attach it', async t => {
  const f = await fixture(t), originalEmit = Server.prototype.emit, originalWrite = Duplex.prototype.write;
  let sink, pipes = 0, held, sawWrite;
  const handshakeWritten = new Promise(resolve => { sawWrite = resolve; });
  t.mock.method(Server.prototype, 'emit', function (event, ...args) {
    if (event === 'connection' && this.address()?.port === f.relay.proxyPort) {
      sink = args[0]; sink.on('pipe', () => pipes++);
    }
    return originalEmit.call(this, event, ...args);
  });
  t.mock.method(Duplex.prototype, 'write', function (chunk, encoding, callback) {
    if (!held && Buffer.isBuffer(chunk) && chunk.subarray(0, 9).toString() === 'GET /rpc?' && typeof encoding === 'function') {
      return originalWrite.call(this, chunk, error => {
        held = () => encoding(error); sawWrite();
      });
    }
    return originalWrite.call(this, chunk, encoding, callback);
  });
  const release = () => { const callback = held; held = null; callback?.(); };
  t.after(release);
  await f.openRaw(); await bounded(handshakeWritten);
  assert.equal(pipes, 0); assert.equal(sink.destroyed, false);
  const closed = new Promise(resolve => sink.once('close', resolve));
  const began = performance.now(); f.client.close();
  await bounded(closed, 1500);
  assert.ok(performance.now() - began < 1500);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(pipes, 0, 'the held original write callback cannot install a bridge after revocation');
});
