// Owned local stream/loopback contracts only; no public Relay or platform account.
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { createServer, connect } from 'node:net';
import WebSocket, { WebSocketServer, createWebSocketStream } from 'ws';
import { bridgeRaw, RelayDuplex } from '../src/transport.mjs';

async function bounded(promise, ms = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned stream fixture deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}

test('Node Writable serializes pre-attach writes and connect-listener writes in original order', async t => {
  const tunnel = new RelayDuplex(), upstream = new PassThrough();
  t.after(() => { tunnel.destroy(); upstream.destroy(); });
  tunnel.on('error', () => {}); upstream.on('error', () => {}); tunnel.resume();
  const received = [];
  upstream.on('data', chunk => received.push(Buffer.from(chunk)));
  tunnel.write('before');
  assert.equal(tunnel.pendingWrites.length, 1);
  tunnel.once('connect', () => tunnel.write('on-connect'));
  assert.equal(tunnel.attach(upstream), true);
  await bounded(new Promise((resolve, reject) => tunnel.end('tail', error => error ? reject(error) : resolve())));
  assert.equal(Buffer.concat(received).toString(), 'beforeon-connecttail');
});

test('destroy settles every queued callback once and a late attach cannot lose them', async t => {
  const tunnel = new RelayDuplex(), upstream = new PassThrough();
  t.after(() => { tunnel.destroy(); upstream.destroy(); });
  tunnel.on('error', () => {}); upstream.on('error', () => {});
  let callbacks = 0;
  const settled = [];
  for (let i = 0; i < 3; i++) settled.push(new Promise(resolve => {
    tunnel.write(Buffer.alloc(32 * 1024), error => { callbacks++; assert.ok(error); resolve(); });
  }));
  assert.equal(tunnel.pendingWrites.length, 1, 'the private queue holds only the active _write');
  assert.equal(tunnel.writableNeedDrain, true, 'ordinary Writable backpressure remains active');
  const closed = new Promise(resolve => tunnel.once('close', resolve));
  tunnel.destroy(new Error('owned cancellation'));
  assert.equal(tunnel.attach(upstream), false);
  await bounded(Promise.all([...settled, closed]));
  assert.equal(callbacks, 3);
  assert.equal(upstream.destroyed, true);
  assert.equal(tunnel.pendingWrites.length, 0);
});

test('read(0) remains valid while a readable is paused', () => {
  const stream = new Readable({ read() {} });
  stream.pause(); stream.push(null);
  assert.doesNotThrow(() => stream.read(0));
  stream.destroy();
});

test('the default WebSocket stream sends non-UTF8 bytes as binary frames without recoding', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(server, 'listening');
  let peer, socket, stream;
  t.after(async () => {
    stream?.destroy(); socket?.terminate(); peer?.terminate();
    await bounded(new Promise(resolve => server.close(resolve)));
  });
  const payload = Buffer.from([0, 255, 254, 192, 128, 0, 127]);
  const frame = new Promise(resolve => server.once('connection', value => {
    peer = value;
    peer.on('message', (data, binary) => { resolve({ data: Buffer.from(data), binary }); peer.send(data, { binary }); });
  }));
  socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { perMessageDeflate: false });
  socket.on('error', () => {});
  stream = createWebSocketStream(socket, { highWaterMark: 64 * 1024 });
  stream.on('error', () => {});
  const echo = once(stream, 'data');
  stream.write(payload);
  const result = await bounded(frame);
  assert.equal(result.binary, true);
  assert.deepEqual(result.data, payload);
  assert.deepEqual((await bounded(echo))[0], payload);
  assert.equal(Buffer.isEncoding('buffer'), false, 'the suggested buffer encoding is not a Node encoding');
});

test('raw traffic gates count UTF8 bytes even when the source readable emits strings', async t => {
  const source = new PassThrough(); source.setEncoding('utf8'); source.on('error', () => {});
  let sink, client, cleanup;
  const measured = [];
  const server = createServer(socket => { sink = socket; socket.on('error', () => {}); cleanup = bridgeRaw(socket, source, () => {}, bytes => { measured.push(bytes); return true; }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    cleanup?.(); client?.destroy(); sink?.destroy(); source.destroy();
    await bounded(new Promise(resolve => server.close(resolve)));
  });
  client = connect({ host: '127.0.0.1', port: server.address().port }); client.on('error', () => {});
  const reply = once(client, 'data'); client.write('中文');
  assert.deepEqual((await bounded(reply))[0], Buffer.from('中文'));
  assert.deepEqual(measured, [6, 6]);
});
