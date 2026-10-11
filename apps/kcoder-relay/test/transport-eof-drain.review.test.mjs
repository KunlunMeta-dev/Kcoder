// Model-independent owned loopback TCP/WebSocket contracts. Not a public
// Relay incident reproduction, Rust Gateway, Provider or performance result.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as tcpServer, connect } from 'node:net';
import { createServer as httpServer, request } from 'node:http';
import test from 'node:test';
import WebSocket, { WebSocketServer, createWebSocketStream } from 'ws';
import { bridge, RelayDuplex, RELAY_EOF_DRAIN_TIMEOUT_MS } from '../src/transport.mjs';
import { startRelay } from '../src/server.mjs';
import { startClient } from '../src/client.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function bounded(promise, ms = 3000, phase = 'unlabeled', snapshot = () => null) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `owned loopback contract deadline: ${phase}; state=${JSON.stringify(snapshot())}`,
    )), ms);
  })]); } finally { clearTimeout(timer); }
}
function streamState(value) {
  if (!value) return null;
  return Object.fromEntries(['readableEnded', 'writableFinished', 'destroyed', 'closed',
    'readableLength', 'writableLength'].map(key => [key, value[key] ?? null]));
}
function awaitOwnerClose(value) {
  if (!value || value.closed === true || value.readyState === WebSocket.CLOSED) return Promise.resolve();
  // Subscribe before cleanup/destroy; server.close does not prove that every
  // accepted socket's close listener (including Set deletion) has executed.
  return new Promise(resolve => value.once('close', resolve));
}
async function openBridge(t) {
  const sourceReady = deferred(), localClosed = deferred(), bridgeClosed = deferred();
  const tcp = tcpServer(socket => { socket.resume(); sourceReady.resolve(socket); });
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  const chunks = [], sockets = new Set();
  tcp.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let ws, local, peer, stream, bridgeStream, cleanup, expectedBodyHash, closeCount = 0;
  const snapshot = () => ({
    local: streamState(local), bridgeStream: streamState(bridgeStream),
    peerStream: streamState(stream), dataTcp: streamState(ws?._socket),
    wsState: ws?.readyState ?? null, peerWsState: peer?.readyState ?? null,
    closeCount, receivedLength: Buffer.concat(chunks).length,
    receivedHashMatches: expectedBodyHash === undefined ? null :
      createHash('sha256').update(Buffer.concat(chunks)).digest('hex') === expectedBodyHash,
  });
  const peerReady = deferred();
  wss.once('connection', socket => {
    peer = socket;
    peer.on('error', () => {});
    stream = createWebSocketStream(peer);
    stream.on('error', () => {});
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    peerReady.resolve();
  });
  t.after(async () => {
    const accepted = [...sockets];
    const closedOwners = Promise.all([local, ws, peer, stream, bridgeStream, ...accepted].map(awaitOwnerClose));
    cleanup?.();
    local?.destroy(); ws?.terminate(); peer?.terminate(); stream?.destroy();
    for (const socket of accepted) socket.destroy();
    const closedServers = Promise.all([
      new Promise(resolve => tcp.close(resolve)), new Promise(resolve => wss.close(resolve)),
    ]);
    await bounded(closedOwners, 3000, 'fixture-owned-close-events', snapshot);
    await bounded(closedServers, 3000, 'fixture-server-close-callbacks', snapshot);
    assert.equal(sockets.size, 0, 'no owned Gateway TCP socket remains');
    assert.equal(wss.clients.size, 0, 'no owned data WebSocket remains');
  });
  tcp.listen(0, '127.0.0.1');
  await Promise.all([once(tcp, 'listening'), once(wss, 'listening')]);
  ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}`, { perMessageDeflate: false });
  ws.on('error', () => {});
  const bound = deferred();
  ws.once('open', () => {
    // Cork only this test's owned data socket before its local TCP connects.
    ws._socket.cork();
    local = connect({ host: '127.0.0.1', port: tcp.address().port });
    local.once('close', hadError => localClosed.resolve({ hadError, queued: ws._socket.writableLength }));
    local.once('pipe', source => { bridgeStream = source; });
    cleanup = bridge(local, ws, () => { closeCount += 1; bridgeClosed.resolve(); });
    bound.resolve();
  });
  await bounded(Promise.all([bound.promise, peerReady.promise]), 3000, 'fixture-data-peer-and-bridge', snapshot);
  const source = await bounded(sourceReady.promise, 3000, 'fixture-local-tcp-connect', snapshot);
  return { source, ws, localClosed, bridgeClosed, cleanup, chunks, snapshot,
    expectBody(body) { expectedBodyHash = createHash('sha256').update(body).digest('hex'); },
    count: () => closeCount };
}

test('normal EOF keeps queued response bytes alive through one 100ms cork', async t => {
  const f = await openBridge(t);
  const body = Buffer.from('complete-session-body-for-transport-contract');
  f.expectBody(body);
  f.source.end(body);
  const closed = await bounded(f.localClosed.promise, 3000, 'cork-local-orderly-close', f.snapshot);
  assert.equal(closed.hadError, false);
  assert.ok(closed.queued > 0, 'causal gate: the owned data socket has pending bytes');
  assert.equal(f.count(), 0, 'orderly local close cannot eagerly terminate the data owner');
  assert.equal(f.ws._socket.destroyed, false);
  await new Promise(resolve => { const timer = setTimeout(resolve, 100); t.after(() => clearTimeout(timer)); });
  f.ws._socket.uncork();
  await bounded(f.bridgeClosed.promise, 3000, 'cork-bridge-close-after-uncork', f.snapshot);
  assert.deepEqual(Buffer.concat(f.chunks), body);
  assert.equal(f.count(), 1);
});

test('explicit owner cleanup is immediate even during a corked EOF', async t => {
  const f = await openBridge(t);
  f.source.end(Buffer.from('cancel-owned-transfer'));
  assert.ok((await bounded(f.localClosed.promise, 3000, 'explicit-local-orderly-close', f.snapshot)).queued > 0);
  f.cleanup(); f.cleanup();
  assert.equal(f.count(), 1);
  assert.equal(f.ws._socket.destroyed, true);
  await bounded(f.bridgeClosed.promise, 3000, 'explicit-bridge-close', f.snapshot);
});

test('a never-uncorked orderly EOF reaches the fixed total drain deadline', async t => {
  const f = await openBridge(t);
  const started = performance.now();
  f.source.end(Buffer.from('never-flushed'));
  assert.ok((await bounded(f.localClosed.promise, 3000, 'never-uncork-local-orderly-close', f.snapshot)).queued > 0);
  assert.equal(f.count(), 0);
  await bounded(f.bridgeClosed.promise, RELAY_EOF_DRAIN_TIMEOUT_MS + 1500, 'never-uncork-production-deadline', f.snapshot);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= RELAY_EOF_DRAIN_TIMEOUT_MS - 50);
  assert.ok(elapsed < RELAY_EOF_DRAIN_TIMEOUT_MS + 1500);
  assert.equal(f.ws._socket.destroyed, true);
  assert.equal(f.count(), 1);
});

test('server readable backlog survives normal WS EOF until full session HTTP completes', async t => {
  const id = 'owned-drain-review', host = 'owned-drain-review.test';
  const secret = randomBytes(32).toString('hex'), pairingToken = randomBytes(32).toString('hex');
  const session = { accessToken: randomBytes(32).toString('hex'), rpcToken: randomBytes(32).toString('hex'), expiresAt: Date.now() + 120000 };
  const body = Buffer.from(JSON.stringify(session));
  const paused = deferred(), requestSeen = deferred(), releaseResponse = deferred();
  const originalAttach = RelayDuplex.prototype.attach;
  let selectedStream, upstreamBytesAtClose, client, relay, pauseTimer;
  let selected = 0;
  // Test-only once-owned consumer pause, not a production observer/API or a
  // global cache. This file must run serially, alone, in its Node worker.
  RelayDuplex.prototype.attach = function (stream, close) {
    const result = originalAttach.call(this, stream, close);
    assert.equal(++selected, 1, 'the only fixture session owns exactly one selected stream');
    selectedStream = stream;
    stream.pause();
    paused.resolve();
    return result;
  };
  const gatewaySockets = new Set();
  const gateway = httpServer(async (incoming, response) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(incoming.method, 'POST'); assert.equal(incoming.url, '/api/mobile/session');
      assert.equal(parsed.token === pairingToken, true, 'owned pairing token matches');
      requestSeen.resolve();
      await releaseResponse.promise;
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length, connection: 'close' });
      response.end(body);
    } catch (error) { requestSeen.reject(error); response.destroy(); }
  });
  gateway.on('connection', socket => { gatewaySockets.add(socket); socket.once('close', () => gatewaySockets.delete(socket)); });
  t.after(async () => {
    RelayDuplex.prototype.attach = originalAttach;
    clearTimeout(pauseTimer); releaseResponse.resolve(); selectedStream?.resume();
    client?.close(); await relay?.close();
    gateway.closeAllConnections();
    await bounded(new Promise(resolve => gateway.close(resolve)));
    assert.equal(gatewaySockets.size, 0);
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  relay = await startRelay({ gateways: [{ id, secret, pairingToken, maxConnections: 2, maxBytesPerWindow: 1024 * 1024, trafficWindowMs: 60000 }], sharedHosts: [host], controlPort: 0, proxyPort: 0 });
  const online = deferred();
  client = startClient({ url: `http://127.0.0.1:${relay.controlPort}`, secret, gatewayId: id,
    gateway: `http://127.0.0.1:${gateway.address().port}`, allowInsecure: true, onOnline: online.resolve });
  await bounded(online.promise);
  const response = new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ token: pairingToken }));
    const outgoing = request({ host: '127.0.0.1', port: relay.proxyPort, method: 'POST', path: `/g/${id}/api/mobile/session`,
      headers: { host, 'content-type': 'application/json', 'content-length': payload.length, connection: 'close' } }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.once('aborted', () => reject(new Error('session response aborted')));
      incoming.once('error', reject);
      incoming.once('end', () => resolve({ status: incoming.statusCode, complete: incoming.complete,
        length: incoming.headers['content-length'], body: Buffer.concat(chunks) }));
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('session HTTP deadline')));
    t.after(() => outgoing.destroy());
    outgoing.end(payload);
  });
  const resultPromise = bounded(response);
  await bounded(Promise.all([paused.promise, requestSeen.promise]));
  // ws.close pushes stream EOF, but paused readable data must still be intact.
  const wsClose = deferred();
  const originalEmit = selectedStream.push.bind(selectedStream);
  selectedStream.push = function (chunk, encoding) {
    const result = originalEmit(chunk, encoding);
    if (chunk === null) wsClose.resolve();
    return result;
  };
  t.after(() => { if (selectedStream) selectedStream.push = originalEmit; });
  releaseResponse.resolve();
  await bounded(wsClose.promise);
  upstreamBytesAtClose = selectedStream.readableLength;
  assert.ok(upstreamBytesAtClose > body.length, 'causal gate: HTTP header/body remain unread at normal WS EOF');
  assert.equal(selectedStream.destroyed, false);
  await new Promise(resolve => { pauseTimer = setTimeout(resolve, 100); });
  selectedStream.resume();
  const result = await resultPromise;
  assert.equal(result.status, 200); assert.equal(result.complete, true);
  assert.equal(result.length, String(body.length)); assert.equal(result.body.equals(body), true, 'complete session body matches');
});
